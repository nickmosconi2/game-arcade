// Keeps the overlay locked to the arm between hand detections (for example when the phone is
// close to the forearm and the hand is out of view). Tracks a grid of points on the skin with
// pyramidal Lucas-Kanade optical flow and estimates how the picture moved: shift, turn and zoom.

const W = 192;                 // working width of the grey image
const LEVELS = 3, WIN = 5, ITERS = 8;

let lastRGBA = null;
function toGray(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  lastRGBA = d;
  return g;
}
function isSkin(x, y, w, skin) {
  if (!skin || !lastRGBA) return true;
  const i = ((y | 0) * w + (x | 0)) * 4, r = lastRGBA[i], g = lastRGBA[i + 1], b = lastRGBA[i + 2];
  const cb = -0.169 * r - 0.331 * g + 0.5 * b, cr = 0.5 * r - 0.419 * g - 0.081 * b;
  return Math.abs(cb - skin.cb) < 14 && Math.abs(cr - skin.cr) < 14;
}
function down(g, w, h) {
  const w2 = w >> 1, h2 = h >> 1, o = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    const i = 2 * y * w + 2 * x;
    o[y * w2 + x] = (g[i] + g[i + 1] + g[i + w] + g[i + w + 1]) * 0.25;
  }
  return { g: o, w: w2, h: h2 };
}
function pyramid(g, w, h) {
  const p = [{ g, w, h }];
  for (let l = 1; l < LEVELS; l++) p.push(down(p[l - 1].g, p[l - 1].w, p[l - 1].h));
  return p;
}
function sample(lv, x, y) {
  const { g, w, h } = lv;
  if (x < 0) x = 0; if (y < 0) y = 0; if (x > w - 1.001) x = w - 1.001; if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
}
/** Track one point from pyramid A to pyramid B. Returns [x, y] or null. */
function lk(A, B, x, y) {
  let gx = 0, gy = 0;
  for (let l = LEVELS - 1; l >= 0; l--) {
    const a = A[l], b = B[l], k = 1 / (1 << l), px = x * k, py = y * k;
    if (l < LEVELS - 1) { gx *= 2; gy *= 2; }
    let gxx = 0, gxy = 0, gyy = 0;
    const ix = [], iy = [], iv = [];
    for (let dy = -WIN; dy <= WIN; dy++) for (let dx = -WIN; dx <= WIN; dx++) {
      const sx = px + dx, sy = py + dy;
      const Ix = (sample(a, sx + 1, sy) - sample(a, sx - 1, sy)) * 0.5, Iy = (sample(a, sx, sy + 1) - sample(a, sx, sy - 1)) * 0.5;
      ix.push(Ix); iy.push(Iy); iv.push(sample(a, sx, sy));
      gxx += Ix * Ix; gxy += Ix * Iy; gyy += Iy * Iy;
    }
    const det = gxx * gyy - gxy * gxy;
    if (det < 1e-3 || Math.min(gxx, gyy) < 30) return null;   // no texture to follow
    let vx = 0, vy = 0;
    for (let it = 0; it < ITERS; it++) {
      let bx = 0, by = 0, n = 0;
      for (let dy = -WIN; dy <= WIN; dy++) for (let dx = -WIN; dx <= WIN; dx++, n++) {
        const diff = iv[n] - sample(b, px + dx + gx + vx, py + dy + gy + vy);
        bx += diff * ix[n]; by += diff * iy[n];
      }
      const ux = (gyy * bx - gxy * by) / det, uy = (gxx * by - gxy * bx) / det;
      vx += ux; vy += uy;
      if (ux * ux + uy * uy < 0.0009) break;
    }
    gx += vx; gy += vy;
  }
  return [x + gx, y + gy];
}

export function createFlowTracker() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let prev = null, pts = [], w = 0, h = 0, frames = 0;
  return {
    reset() { prev = null; pts = []; },
    get points() { return pts.length; },
    /**
     * Feed one frame. `region` is where to put fresh points, in 0..1 picture coordinates:
     * {cx, cy, rx, ry} (an ellipse around the arm). Returns the motion since the last frame in
     * 0..1 picture coordinates: {dx, dy, rot, scale, cx, cy} about the centre (cx, cy), or null.
     */
    update(source, region, skin) {
      const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
      if (!sw || !sh) return null;
      w = W; h = Math.round(W * sh / sw);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; prev = null; }
      ctx.drawImage(source, 0, 0, w, h);
      const cur = pyramid(toGray(ctx, w, h), w, h);
      let motion = null;
      if (prev && pts.length >= 6) {
        const a = [], b = [];
        for (const p of pts) {
          const q = lk(prev, cur, p[0], p[1]);
          if (!q || q[0] < 2 || q[1] < 2 || q[0] > w - 3 || q[1] > h - 3) continue;
          const back = lk(cur, prev, q[0], q[1]);                      // forward-backward check
          if (!back || Math.hypot(back[0] - p[0], back[1] - p[1]) > 0.8) continue;
          a.push(p); b.push(q);
        }
        motion = fitSimilarity(a, b, w, h);
        pts = motion ? motion.inliers : [];
      }
      frames++;
      if (region && (pts.length < 40 || frames % 20 === 0)) pts = seed(cur[0], region, w, h, pts, skin);
      prev = cur;
      return motion;
    },
  };
}

function seed(lv, r, w, h, keep, skin) {
  const out = keep.slice(), cx = r.cx * w, cy = r.cy * h, rx = Math.max(8, r.rx * w), ry = Math.max(8, r.ry * h);
  const step = Math.max(4, Math.round(Math.sqrt((rx * ry * 3.2) / 90)));
  for (let y = cy - ry; y <= cy + ry; y += step) for (let x = cx - rx; x <= cx + rx; x += step) {
    if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1 || x < 8 || y < 8 || x > w - 9 || y > h - 9) continue;
    if (!isSkin(x, y, w, skin)) continue;
    if (out.some((p) => Math.abs(p[0] - x) < step * 0.6 && Math.abs(p[1] - y) < step * 0.6)) continue;
    // Corner strength: only keep points with texture in both directions.
    let gxx = 0, gyy = 0, gxy = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const Ix = sample(lv, x + dx + 1, y + dy) - sample(lv, x + dx - 1, y + dy), Iy = sample(lv, x + dx, y + dy + 1) - sample(lv, x + dx, y + dy - 1);
      gxx += Ix * Ix; gyy += Iy * Iy; gxy += Ix * Iy;
    }
    const minEig = (gxx + gyy) / 2 - Math.sqrt(((gxx - gyy) / 2) ** 2 + gxy * gxy);
    if (minEig > 40) out.push([x, y]);
  }
  return out.slice(0, 160);
}

/** Robust least-squares similarity transform b ≈ s·R·a + t. Returns null if not enough agreement. */
function fitSimilarity(a, b, w, h) {
  if (a.length < 6) return null;
  const solve = (idx) => {
    let ax = 0, ay = 0, bx = 0, by = 0;
    for (const i of idx) { ax += a[i][0]; ay += a[i][1]; bx += b[i][0]; by += b[i][1]; }
    const n = idx.length; ax /= n; ay /= n; bx /= n; by /= n;
    let sxx = 0, sxy = 0, saa = 0;
    for (const i of idx) {
      const px = a[i][0] - ax, py = a[i][1] - ay, qx = b[i][0] - bx, qy = b[i][1] - by;
      sxx += px * qx + py * qy; sxy += px * qy - py * qx; saa += px * px + py * py;
    }
    if (saa < 1e-6) return null;
    const c = sxx / saa, s = sxy / saa;   // c = scale·cos, s = scale·sin
    return { c, s, tx: bx - (c * ax - s * ay), ty: by - (s * ax + c * ay) };
  };
  const err = (m, i) => Math.hypot(m.c * a[i][0] - m.s * a[i][1] + m.tx - b[i][0], m.s * a[i][0] + m.c * a[i][1] + m.ty - b[i][1]);
  let best = null, bestIn = [];
  const all = a.map((_, i) => i);
  for (let it = 0; it < 30; it++) {
    const i = (Math.random() * a.length) | 0, j = (Math.random() * a.length) | 0;
    if (i === j) continue;
    const m = solve([i, j]);
    if (!m) continue;
    const inl = all.filter((k) => err(m, k) < 1.2);
    if (inl.length > bestIn.length) { best = m; bestIn = inl; }
  }
  if (!best || bestIn.length < Math.max(6, a.length * 0.4)) return null;
  const m = solve(bestIn) || best;
  const scale = Math.hypot(m.c, m.s), rot = Math.atan2(m.s, m.c);
  if (scale < 0.85 || scale > 1.18 || Math.abs(rot) > 0.35) return null;   // implausible jump in one frame
  // Express as motion about the centre of the tracked points.
  let cx = 0, cy = 0;
  for (const i of bestIn) { cx += a[i][0]; cy += a[i][1]; }
  cx /= bestIn.length; cy /= bestIn.length;
  const nx = m.c * cx - m.s * cy + m.tx, ny = m.s * cx + m.c * cy + m.ty;
  return { dx: (nx - cx) / w, dy: (ny - cy) / h, rot, scale, cx: cx / w, cy: cy / h, inliers: bestIn.map((i) => b[i]), count: bestIn.length };
}
