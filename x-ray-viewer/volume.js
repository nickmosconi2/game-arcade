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

/** Copy of the volume with the outer `mm` of the body removed, so a tissue surface starts under the skin. */
export function peelSkin(vol, bodyIso, mm) {
  const [nx, ny, nz] = vol.dims, sp = vol.spacing, src = vol.data, n = src.length;
  let mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = src[i] > bodyIso ? 1 : 0;
  const minSp = Math.min(...sp), strides = [1, nx, nx * ny], dims = [nx, ny, nz];
  const axes = [0, 1, 2].filter((a) => sp[a] <= 1.5 * minSp && dims[a] > 2);
  const steps = Math.max(1, Math.round(mm / minSp));
  for (let s = 0; s < steps; s++) {
    const out = new Uint8Array(n);
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
      let i = (z * ny + y) * nx;
      for (let x = 0; x < nx; x++, i++) {
        if (!mask[i]) continue;
        const c = [x, y, z];
        let keep = 1;
        for (const a of axes) {
          if (c[a] === 0 || c[a] === dims[a] - 1 || !mask[i - strides[a]] || !mask[i + strides[a]]) { keep = 0; break; }
        }
        out[i] = keep;
      }
    }
    mask = out;
  }
  const data = new Int16Array(n);
  for (let i = 0; i < n; i++) data[i] = mask[i] ? src[i] : -1000;
  return { ...vol, data };
}

/**
 * Works out how a limb scan is laid out, with no user input:
 * which way is the hand, where the wrist is, the direction of the forearm and which side the thumb is on.
 * Returns null if nothing usable is found. All positions are in mm in the volume's own grid.
 */
export function analyzeLimb(vol, bodyIso, boneIso) {
  const dims = vol.dims, sp = vol.spacing, d = vol.data, strides = [1, dims[0], dims[0] * dims[1]];
  // Long axis = longest side of the body's bounding box.
  const lo = [1e9, 1e9, 1e9], hi = [-1, -1, -1];
  for (let z = 0, i = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++, i++) {
    if (d[i] > bodyIso) {
      if (x < lo[0]) lo[0] = x; if (x > hi[0]) hi[0] = x;
      if (y < lo[1]) lo[1] = y; if (y > hi[1]) hi[1] = y;
      if (z < lo[2]) lo[2] = z; if (z > hi[2]) hi[2] = z;
    }
  }
  if (hi[0] < 0) return null;
  const ext = [0, 1, 2].map((a) => (hi[a] - lo[a] + 1) * sp[a]);
  const L = ext.indexOf(Math.max(...ext)), U = (L + 1) % 3, V = (L + 2) % 3;
  const nL = dims[L], nU = dims[U], nV = dims[V], sL = strides[L], sU = strides[U], sV = strides[V];
  const pixArea = sp[U] * sp[V], minVox = Math.max(2, Math.round(6 / pixArea));
  const bone = new Uint8Array(nU * nV), stack = new Int32Array(nU * nV);
  const slices = [];
  for (let k = 0; k < nL; k++) {
    let count = 0, su = 0, sv = 0, suu = 0, svv = 0, suv = 0;
    for (let v = 0; v < nV; v++) for (let u = 0; u < nU; u++) {
      const val = d[k * sL + u * sU + v * sV];
      if (val > bodyIso) { count++; su += u; sv += v; suu += u * u; svv += v * v; suv += u * v; }
      bone[v * nU + u] = boneIso !== null && val > boneIso ? 1 : 0;
    }
    const s = { area: count * pixArea, cu: 0, cv: 0, width: 0, comps: [] };
    if (count) {
      const mu = su / count, mv = sv / count;
      const a = (suu / count - mu * mu) * sp[U] * sp[U], c = (svv / count - mv * mv) * sp[V] * sp[V], b = (suv / count - mu * mv) * sp[U] * sp[V];
      s.cu = mu * sp[U]; s.cv = mv * sp[V];
      s.width = 4 * Math.sqrt(Math.max(0, (a + c) / 2 + Math.sqrt(((a - c) / 2) ** 2 + b * b)));
    }
    if (boneIso !== null) {
      for (let start = 0; start < bone.length; start++) {
        if (bone[start] !== 1) continue;
        let top = 0, area = 0, bu = 0, bv = 0;
        stack[top++] = start; bone[start] = 2;
        while (top) {
          const p = stack[--top], u = p % nU, v = (p - u) / nU;
          area++; bu += u; bv += v;
          if (u > 0 && bone[p - 1] === 1) { bone[p - 1] = 2; stack[top++] = p - 1; }
          if (u < nU - 1 && bone[p + 1] === 1) { bone[p + 1] = 2; stack[top++] = p + 1; }
          if (v > 0 && bone[p - nU] === 1) { bone[p - nU] = 2; stack[top++] = p - nU; }
          if (v < nV - 1 && bone[p + nU] === 1) { bone[p + nU] = 2; stack[top++] = p + nU; }
        }
        if (area >= minVox) s.comps.push({ area: area * pixArea, cu: bu / area * sp[U], cv: bv / area * sp[V] });
      }
    }
    slices.push(s);
  }
  const valid = (k) => k >= 0 && k < nL && slices[k].area > 150;
  let k0 = 0, k1 = nL - 1;
  while (k0 < nL && !valid(k0)) k0++;
  while (k1 > k0 && !valid(k1)) k1--;
  if (k1 - k0 < 5) return null;
  const widths = [];
  for (let k = k0; k <= k1; k++) widths.push(slices[k].width);
  const sorted = widths.slice().sort((a, b) => a - b);
  const maxWidth = sorted[Math.floor(sorted.length * 0.9)], length = (k1 - k0 + 1) * sp[L];
  const meanWidth = (a, b) => { let s = 0, n = 0; for (let k = a; k <= b; k++) { s += slices[k].width; n++; } return s / Math.max(n, 1); };
  const span = Math.max(2, Math.round((k1 - k0) * 0.15));

  // Hand = where a cross-section cuts four or more separate bones (metacarpals, fingers).
  const handK = [];
  for (let k = k0; k <= k1; k++) if (slices[k].comps.length >= 4) handK.push(k);
  const hasHand = handK.length * sp[L] >= 8;
  let dir, wristK;
  if (hasHand) {
    const mean = handK.reduce((a, b) => a + b, 0) / handK.length;
    dir = mean > (k0 + k1) / 2 ? 1 : -1;
    // Walk from the hand toward the elbow until the two forearm bones run on their own for 15 mm.
    const need = Math.max(4, Math.round(20 / sp[L]));
    wristK = dir > 0 ? Math.min(...handK) : Math.max(...handK);
    for (let k = wristK; valid(k - dir * need); k -= dir) {
      let ok = true, pairs = 0;
      for (let j = 0; j < need; j++) { const n = slices[k - dir * j].comps.length; if (n < 1 || n > 2) { ok = false; break; } if (n === 2) pairs++; }
      if (ok && pairs >= need * 0.7) { wristK = k; break; }
    }
    // The wrist is the narrowest part of the arm between there and the hand.
    const handStart = dir > 0 ? Math.min(...handK) : Math.max(...handK);
    let best = wristK, bestW = Infinity;
    for (let k = wristK - dir * Math.round(50 / sp[L]); dir > 0 ? k <= handStart : k >= handStart; k += dir) {
      if (!valid(k)) continue;
      let w = 0, n = 0;
      for (let j = -2; j <= 2; j++) if (valid(k + j)) { w += slices[k + j].width; n++; }
      w /= n;
      if (w < bestW - 0.25) { bestW = w; best = k; }
    }
    wristK = Math.round(best + dir * 8 / sp[L]);
  } else {
    dir = meanWidth(k1 - span, k1) < meanWidth(k0, k0 + span) ? 1 : -1;
    wristK = dir > 0 ? k1 - Math.round(5 / sp[L]) : k0 + Math.round(5 / sp[L]);
  }
  wristK = Math.min(k1, Math.max(k0, wristK));
  const point = (k, cu, cv) => { const p = [0, 0, 0]; p[L] = k * sp[L]; p[U] = cu; p[V] = cv; return p; };
  const centroid = (a, b) => {
    let n = 0; const c = [0, 0, 0];
    for (let k = Math.min(a, b); k <= Math.max(a, b); k++) if (valid(k)) { const p = point(k, slices[k].cu, slices[k].cv); c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; n++; }
    return n ? c.map((x) => x / n) : null;
  };
  // Forearm direction: line through the middle of the arm over the 15 cm above the wrist.
  const kNear = wristK - dir * Math.round(10 / sp[L]), kFar = wristK - dir * Math.round(150 / sp[L]);
  const kFarC = Math.min(k1, Math.max(k0, kFar)), kMid = Math.round((kNear + kFarC) / 2);
  const near = centroid(kNear, kMid), far = centroid(kMid, kFarC);
  let distal = [0, 0, 0]; distal[L] = dir;
  if (near && far) {
    const v = [near[0] - far[0], near[1] - far[1], near[2] - far[2]], len = Math.hypot(...v);
    if (len > 10) distal = v.map((x) => x / len);
  }
  // Thumb side: just above the wrist the radius is the larger of the two bones.
  let thumb = null;
  if (boneIso !== null) {
    const t = [0, 0, 0];
    for (let j = Math.round(4 / sp[L]); j <= Math.round(40 / sp[L]); j++) {
      const k = wristK - dir * j;
      if (!valid(k) || slices[k].comps.length !== 2) continue;
      const [a, b] = slices[k].comps, big = a.area >= b.area ? a : b, small = a.area >= b.area ? b : a;
      if (big.area < small.area * 1.15) continue;
      const w = big.area - small.area;
      t[U] += (big.cu - small.cu) * w; t[V] += (big.cv - small.cv) * w;
    }
    if (Math.hypot(...t) > 0) thumb = t;
  }
  const ws = slices[wristK];
  return { long: L, length, maxWidth, hasHand, wrist: point(wristK, ws.cu, ws.cv), distal, thumb };
}
