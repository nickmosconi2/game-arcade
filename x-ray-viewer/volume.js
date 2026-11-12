// Turns parsed DICOM files into series, and a series into a 3D volume + surface meshes.
import { decodeFrame } from './dicom.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Group files by series and order the slices along the scan direction. */
export function groupSeries(files) {
  const map = new Map();
  for (const f of files) {
    const key = `${f.seriesUID || f.name}|${f.rows}x${f.columns}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  }
  const series = [];
  for (const list of map.values()) {
    const f0 = list[0];
    let normal = [0, 0, 1];
    const o = f0.orientation;
    if (Array.isArray(o) && o.length === 6) {
      normal = [o[1] * o[5] - o[2] * o[4], o[2] * o[3] - o[0] * o[5], o[0] * o[4] - o[1] * o[3]];
    }
    const hasPos = list.every((f) => Array.isArray(f.position) && f.position.length === 3);
    for (const f of list) f.loc = hasPos ? dot(f.position, normal) : (f.instanceNumber || 0);
    list.sort((a, b) => a.loc - b.loc);
    // Slices to show: one per file, or one per frame of a multi-frame file.
    const slices = [];
    for (const f of list) for (let k = 0; k < f.frames; k++) slices.push({ file: f, frame: k });
    let dz = f0.spacingBetweenSlices || f0.sliceThickness || 1;
    if (hasPos && list.length > 1) {
      const gaps = [];
      for (let i = 1; i < list.length; i++) gaps.push(Math.abs(list[i].loc - list[i - 1].loc));
      gaps.sort((a, b) => a - b);
      const med = gaps[gaps.length >> 1];
      if (med > 1e-3) dz = med;
    }
    series.push({
      slices, rows: f0.rows, columns: f0.columns, modality: f0.modality || '?',
      description: f0.seriesDescription || f0.studyDescription || f0.name,
      spacing: [f0.colSpacing, f0.rowSpacing, Math.abs(dz) || 1],
      spacingKnown: f0.spacingKnown, first: f0,
      isVolume: slices.length >= 8,
    });
  }
  series.sort((a, b) => b.slices.length - a.slices.length);
  return series;
}

/**
 * Build a (possibly down-sampled) Int16 volume for 3D work.
 * Phones cannot hold a full 512x512x400 scan plus meshes, so in-plane resolution is
 * averaged down to about `maxSide` and the slice count to about `maxSlices`.
 */
export async function buildVolume(series, onProgress, maxSide = 256, maxSlices = 220) {
  const { rows, columns, slices } = series;
  const f = Math.max(1, Math.ceil(Math.max(rows, columns) / maxSide));
  const fz = Math.max(1, Math.ceil(slices.length / maxSlices));
  const nx = Math.floor(columns / f), ny = Math.floor(rows / f), nz = Math.floor(slices.length / fz);
  const data = new Int16Array(nx * ny * nz);
  const acc = new Float32Array(nx * ny);
  const norm = 1 / (f * f * fz);
  for (let z = 0; z < nz; z++) {
    acc.fill(0);
    for (let k = 0; k < fz; k++) {
      const s = slices[z * fz + k];
      const px = await decodeFrame(s.file, s.frame);
      for (let y = 0; y < ny; y++) {
        for (let dy = 0; dy < f; dy++) {
          let src = (y * f + dy) * columns;
          const dst = y * nx;
          for (let x = 0; x < nx; x++) {
            let sum = 0;
            for (let dx = 0; dx < f; dx++) sum += px[src++];
            acc[dst + x] += sum;
          }
        }
      }
    }
    const base = z * nx * ny;
    for (let i = 0; i < nx * ny; i++) {
      const v = acc[i] * norm;
      data[base + i] = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
    }
    if (onProgress && z % 8 === 0) await onProgress(z / nz);
  }
  const sp = series.spacing;
  return { data, dims: [nx, ny, nz], spacing: [sp[0] * f, sp[1] * f, sp[2] * fz] };
}

/** Light 3D smoothing so surfaces are not stair-stepped by noise. */
export function smooth(vol) {
  const [nx, ny, nz] = vol.dims;
  const src = vol.data, tmp = new Int16Array(src.length), out = new Int16Array(src.length);
  const pass = (a, b, step, len, lines, lineStart) => {
    for (let l = 0; l < lines; l++) {
      let i = lineStart(l);
      b[i] = a[i];
      for (let k = 1; k < len - 1; k++) { i += step; b[i] = (a[i - step] + 2 * a[i] + a[i + step]) >> 2; }
      if (len > 1) { i += step; b[i] = a[i]; }
    }
  };
  pass(src, tmp, 1, nx, ny * nz, (l) => l * nx);
  pass(tmp, out, nx, ny, nx * nz, (l) => (Math.floor(l / nx) * ny * nx) + (l % nx));
  pass(out, tmp, nx * ny, nz, nx * ny, (l) => l);
  return { ...vol, data: tmp };
}

/** Threshold between background and tissue for scans without a physical scale (MR). */
export function otsu(data) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < data.length; i += 7) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi <= lo) return lo;
  const bins = 128, hist = new Float64Array(bins), scale = (bins - 1) / (hi - lo);
  let total = 0;
  for (let i = 0; i < data.length; i += 7) { hist[Math.floor((data[i] - lo) * scale)]++; total++; }
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = 0, bestVar = -1;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const d = sumB / wB - (sumAll - sumB) / wF, v = wB * wF * d * d;
    if (v > bestVar) { bestVar = v; best = i; }
  }
  return lo + (best + 0.5) / scale;
}

// --- Surface nets: builds a closed triangle surface where the volume crosses `iso`. ---
const cubeEdges = new Int32Array(24), edgeTable = new Int32Array(256);
{
  let k = 0;
  for (let i = 0; i < 8; i++) for (let j = 1; j <= 4; j <<= 1) { const p = i ^ j; if (i <= p) { cubeEdges[k++] = i; cubeEdges[k++] = p; } }
  for (let i = 0; i < 256; i++) {
    let em = 0;
    for (let j = 0; j < 24; j += 2) { const a = !!(i & (1 << cubeEdges[j])), b = !!(i & (1 << cubeEdges[j + 1])); if (a !== b) em |= 1 << (j >> 1); }
    edgeTable[i] = em;
  }
}

/** Returns {positions: Float32Array (mm), indices: Uint32Array}. Triangles face outward (toward lower values). */
export function surfaceNets(vol, iso) {
  const [nx, ny, nz] = vol.dims, data = vol.data, [sx, sy, sz] = vol.spacing;
  let verts = new Float32Array(1 << 16), nv = 0;
  let faces = new Uint32Array(1 << 17), nf = 0;
  const R = [1, nx + 1, (nx + 1) * (ny + 1)];
  const buf = new Int32Array(R[2] * 2);
  const grid = new Float32Array(8), x = [0, 0, 0], v = [0, 0, 0];
  let n = 0, bufNo = 1;
  for (x[2] = 0; x[2] < nz - 1; ++x[2], n += nx, bufNo ^= 1, R[2] = -R[2]) {
    let m = 1 + (nx + 1) * (1 + bufNo * (ny + 1));
    for (x[1] = 0; x[1] < ny - 1; ++x[1], ++n, m += 2) {
      for (x[0] = 0; x[0] < nx - 1; ++x[0], ++n, ++m) {
        let mask = 0, g = 0, idx = n;
        for (let k = 0; k < 2; ++k, idx += nx * (ny - 2)) {
          for (let j = 0; j < 2; ++j, idx += nx - 2) {
            for (let i = 0; i < 2; ++i, ++g, ++idx) {
              const p = data[idx] - iso;
              grid[g] = p;
              if (p < 0) mask |= 1 << g;
            }
          }
        }
        if (mask === 0 || mask === 0xff) continue;
        const em = edgeTable[mask];
        let count = 0;
        v[0] = v[1] = v[2] = 0;
        for (let i = 0; i < 12; ++i) {
          if (!(em & (1 << i))) continue;
          ++count;
          const e0 = cubeEdges[i << 1], e1 = cubeEdges[(i << 1) + 1], g0 = grid[e0], g1 = grid[e1];
          let t = g0 - g1;
          t = Math.abs(t) > 1e-6 ? g0 / t : 0.5;
          for (let j = 0, k = 1; j < 3; ++j, k <<= 1) {
            const a = e0 & k, b = e1 & k;
            if (a !== b) v[j] += a ? 1 - t : t; else v[j] += a ? 1 : 0;
          }
        }
        const s = 1 / count;
        if (nv + 3 > verts.length) { const g2 = new Float32Array(verts.length * 2); g2.set(verts); verts = g2; }
        buf[m] = nv / 3;
        verts[nv++] = (x[0] + s * v[0]) * sx; verts[nv++] = (x[1] + s * v[1]) * sy; verts[nv++] = (x[2] + s * v[2]) * sz;
        for (let i = 0; i < 3; ++i) {
          if (!(em & (1 << i))) continue;
          const iu = (i + 1) % 3, iv = (i + 2) % 3;
          if (x[iu] === 0 || x[iv] === 0) continue;
          const du = R[iu], dv = R[iv];
          if (nf + 6 > faces.length) { const g2 = new Uint32Array(faces.length * 2); g2.set(faces); faces = g2; }
          if (!(mask & 1)) {
            faces[nf++] = buf[m]; faces[nf++] = buf[m - du]; faces[nf++] = buf[m - du - dv];
            faces[nf++] = buf[m]; faces[nf++] = buf[m - du - dv]; faces[nf++] = buf[m - dv];
          } else {
            faces[nf++] = buf[m]; faces[nf++] = buf[m - dv]; faces[nf++] = buf[m - du - dv];
            faces[nf++] = buf[m]; faces[nf++] = buf[m - du - dv]; faces[nf++] = buf[m - du];
          }
        }
      }
    }
  }
  return { positions: verts.slice(0, nv), indices: faces.slice(0, nf) };
}
