// X-ray Viewer: look at your arm through the phone camera and switch on an "X-ray window"
// that shows the bones and muscle from a real CT scan, lined up with your arm and following it.
import * as THREE from './vendor/three.module.min.js';
import { parseDicom, decodeFrame, unzip, isZip, DicomError } from './dicom.js';
import { groupSeries, buildVolume, smooth, analyzeLimb, otsu } from './volume.js';
import { VolumeView } from './xray.js';
import { createFlowTracker } from './flow.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), video = $('video'), c2d = $('c2d'), c3d = $('c3d');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const nextFrame = () => new Promise((r) => setTimeout(r, 0));
const now = () => performance.now();
const HAND_MM = 88;   // wrist to middle-knuckle distance used when a scan does not say its own
const DEFAULT_SAMPLE = 'samples/vhf-left-arm-ct.zip';

const state = {
  series: [], cur: null, meta: null, mode: 'cam',
  slice: 0, wc: 300, ww: 1500, sliceCache: null, view2d: { zoom: 1, x: 0, y: 0 },
  vol: null, A: null,            // A: anatomy frame of the scan
  trackable: false, side: 'left', userSide: 'left',
  xray: false, style: 0,         // style 0 = anatomy, 1 = X-ray film
  orbit: new THREE.Quaternion(), zoom3d: 1, pan3d: new THREE.Vector2(),
  camOn: false, camError: '', source: null, testSource: null,
  tracker: null, trackerState: 'off', flow: createFlowTracker(), skin: null,
  locked: false, lastHand: 0, lastGood: 0, fade: 0, forearm: null, loading: false,
  scales: [], widthFit: 1, userSize: 1, sizeShownAt: 0,
};

// ---------- loading ----------
function busy(text) { state.loading = !!text; $('busy').classList.toggle('hidden', !text); if (text) $('busyText').textContent = text; }

async function loadBuffers(items, credit = '') {
  $('err').textContent = '';
  busy('Reading scan…');
  await nextFrame();
  try {
    const raw = [];
    for (const it of items) { if (isZip(it.buffer)) raw.push(...await unzip(it.buffer)); else raw.push(it); }
    let meta = null;
    const files = [], reasons = new Map();
    for (const it of raw) {
      if (/\.json$/i.test(it.name)) { try { meta = JSON.parse(new TextDecoder().decode(it.buffer)); } catch {} continue; }
      try { files.push(parseDicom(it.buffer, it.name.split('/').pop())); }
      catch (e) { if (e instanceof DicomError) reasons.set(e.message, 1); else throw e; }
    }
    if (!files.length) {
      const why = [...reasons.keys()].filter((r) => r !== 'not DICOM' && r !== 'no image in file')[0];
      throw new DicomError(why || 'No DICOM images found in those files.');
    }
    state.series = groupSeries(files);
    state.meta = meta;
    $('credit').textContent = credit;
    await openSeries(0);
    $('sheet').classList.add('hidden');
  } catch (e) {
    console.error(e);
    $('err').textContent = e instanceof DicomError ? e.message : `Could not load: ${e.message}`;
    $('sheet').classList.remove('hidden');
  } finally { busy(''); }
}

async function openSeries(i) {
  const s = state.series[i];
  state.cur = s; state.slice = s.slices.length >> 1; state.sliceCache = null; state.view2d = { zoom: 1, x: 0, y: 0 };
  const isCT = s.modality === 'CT';
  const px = await decodeFrame(s.slices[state.slice].file, s.slices[state.slice].frame);
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < px.length; k += 3) { if (px[k] < lo) lo = px[k]; if (px[k] > hi) hi = px[k]; }
  s.range = isCT ? [-1024, 3000] : [lo, Math.max(hi, lo + 1)];
  if (isCT) { state.wc = 300; state.ww = 1500; }
  else if (Number.isFinite(s.first.windowCenter) && s.first.windowWidth > 0) { state.wc = s.first.windowCenter; state.ww = s.first.windowWidth; }
  else { state.wc = (lo + hi) / 2; state.ww = Math.max(1, hi - lo); }
  setupPresets();
  $('title').textContent = s.description || 'Scan';
  $('slice').max = s.slices.length - 1; $('slice').value = state.slice;
  $('sliceRow').style.display = s.slices.length > 1 ? '' : 'none';

  state.vol = null; state.A = null; state.trackable = false;
  state.orbit.identity(); state.zoom3d = 1; state.pan3d.set(0, 0);
  state.locked = false; state.fade = 0; state.flow.reset(); state.scales = []; state.widthFit = 1; state.userSize = 1;
  if (s.isVolume) {
    let vol = await buildVolume(s, async (p) => { busy(`Building 3D… ${Math.round(p * 100)}%`); await nextFrame(); }, 256, 420);
    if (isCT) vol = smooth(vol);
    state.vol = vol;
    view.setVolume(vol);
    state.A = anatomyFrame(vol, isCT);
    const words = `${s.first.bodyPart || ''} ${s.first.studyDescription || ''} ${s.first.seriesDescription || ''}`;
    state.trackable = !!state.A.limb && !/CHEST|ABDOMEN|PELVIS|HEAD|BRAIN|SPINE|KNEE|ANKLE|FOOT|LEG/i.test(words);
    state.side = state.meta && state.meta.side === 'right' ? 'right' : 'left';
    state.userSide = state.side;
  }
  buildViewChips();
  syncButtons();
  setMode(state.vol ? (state.trackable ? 'cam' : '3d') : '2d');
}

/** Anatomical frame of the scan: origin at the wrist, Y toward the fingers, X toward the thumb. */
function anatomyFrame(vol, isCT) {
  const size = vol.dims.map((d, i) => d * vol.spacing[i]);
  const center = new THREE.Vector3(size[0] / 2, size[1] / 2, size[2] / 2);
  let wrist, fingers, forearm, thumb, limb = false, labels = [], regions = [];
  const m = state.meta && state.meta.frame;
  if (m) {
    wrist = new THREE.Vector3(...m.wrist); fingers = new THREE.Vector3(...m.fingers).normalize();
    forearm = new THREE.Vector3(...m.forearm).normalize(); thumb = new THREE.Vector3(...m.thumb);
    labels = state.meta.labels || []; regions = state.meta.regions || []; limb = true;
  } else {
    const L = analyzeLimb(vol, isCT ? -300 : otsu(vol.data), isCT ? 250 : null);
    if (L && L.maxWidth < 170) {
      wrist = new THREE.Vector3(...L.wrist); fingers = new THREE.Vector3(...L.distal).normalize(); forearm = fingers.clone();
      thumb = L.thumb ? new THREE.Vector3(...L.thumb) : new THREE.Vector3(1, 0, 0); limb = true;
    } else {
      wrist = center.clone(); fingers = new THREE.Vector3(0, 0, 1); forearm = fingers.clone(); thumb = new THREE.Vector3(1, 0, 0);
    }
  }
  if (Math.abs(thumb.clone().normalize().dot(fingers)) > 0.95) thumb = new THREE.Vector3(1, 0, 0);
  const y = fingers.clone(), x = thumb.clone().addScaledVector(y, -thumb.dot(y)).normalize(), z = new THREE.Vector3().crossVectors(x, y);
  const R = new THREE.Matrix4().makeBasis(x, y, z).transpose();   // volume direction -> anatomy direction
  const handLength = (m && m.handLength) || HAND_MM;
  const A = { R, wrist, fingers, forearm, center, limb, labels, regions, size, handLength };
  A.sections = limb ? [50, 75, 100].map((d) => ({ d, pts: crossSection(vol, A, d) })).filter((c) => c.pts.length > 12) : [];
  return A;
}
/**
 * Outline of the arm's skin in a plane across the forearm, `dist` mm from the wrist toward the elbow.
 * Returns points in volume mm. Used to compare the scan's forearm width with the one in the camera.
 */
function crossSection(vol, A, dist) {
  const [nx, ny, nz] = vol.dims, [sx, sy, sz] = vol.spacing, d = vol.data;
  const at = (p) => {
    const i = Math.round(p.x / sx), j = Math.round(p.y / sy), k = Math.round(p.z / sz);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1024;
    return d[(k * ny + j) * nx + i];
  };
  const axis = A.forearm.clone().normalize();
  const c = A.wrist.clone().addScaledVector(axis, -dist);
  const u = new THREE.Vector3(1, 0, 0); if (Math.abs(u.dot(axis)) > 0.9) u.set(0, 1, 0);
  u.addScaledVector(axis, -u.dot(axis)).normalize();
  const v = new THREE.Vector3().crossVectors(axis, u);
  const pts = [];
  for (let a = 0; a < 48; a++) {
    const th = (a / 48) * Math.PI * 2, dir = u.clone().multiplyScalar(Math.cos(th)).addScaledVector(v, Math.sin(th));
    let last = -1;
    for (let r = 0; r < 90; r += 0.75) if (at(c.clone().addScaledVector(dir, r)) > -300) last = r;
    if (last > 5) pts.push(c.clone().addScaledVector(dir, last));
  }
  return pts;
}
/** Volume mm -> anatomy mm, with the origin at `origin` (wrist for the camera, centre for 3D). */
function anatomyMatrix(origin, mirror, widthFit = 1) {
  const M = new THREE.Matrix4();
  if (mirror) M.makeScale(1, 1, -1);           // a right arm is the left arm reflected through the hand's plane
  if (widthFit !== 1) {
    // Stretch across the forearm only (not along it), so a slimmer or broader arm still lines up.
    const f = state.A.forearm.clone().applyMatrix4(new THREE.Matrix4().extractRotation(state.A.R)).normalize();
    const k = widthFit - 1, e = M.elements, S = new THREE.Matrix4().set(
      1 + k * (1 - f.x * f.x), -k * f.x * f.y, -k * f.x * f.z, 0,
      -k * f.y * f.x, 1 + k * (1 - f.y * f.y), -k * f.y * f.z, 0,
      -k * f.z * f.x, -k * f.z * f.y, 1 + k * (1 - f.z * f.z), 0,
      0, 0, 0, 1);
    void e; M.multiply(S);
  }
  return M.multiply(state.A.R).multiply(new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z));
}

// ---------- 2D slices ----------
const off = document.createElement('canvas');
function setupPresets() {
  const s = state.cur, [lo, hi] = s.range, span = hi - lo;
  const presets = s.modality === 'CT'
    ? [['Bone', 300, 1500], ['Soft tissue', 40, 400], ['Lung', -600, 1500]]
    : [['Auto', state.wc, state.ww], ['Brighter', lo + span * 0.3, span * 0.6], ['More contrast', lo + span * 0.5, span * 0.5]];
  const box = $('presets'); box.innerHTML = '';
  presets.forEach(([name, c, w], i) => {
    const b = document.createElement('button'); b.textContent = name; b.classList.toggle('on', i === 0);
    b.onclick = () => { state.wc = c; state.ww = w; for (const o of box.children) o.classList.toggle('on', o === b); draw2d(); };
    box.append(b);
  });
}
async function getSlice() {
  const s = state.cur, i = state.slice;
  if (state.sliceCache && state.sliceCache.i === i && state.sliceCache.s === s) return state.sliceCache.px;
  const px = await decodeFrame(s.slices[i].file, s.slices[i].frame);
  state.sliceCache = { i, s, px };
  return px;
}
let drawing = false, drawAgain = false;
async function draw2d() {
  if (state.mode !== '2d' || !state.cur) return;
  if (drawing) { drawAgain = true; return; }
  drawing = true;
  try {
    const s = state.cur, px = await getSlice();
    if (off.width !== s.columns || off.height !== s.rows) { off.width = s.columns; off.height = s.rows; }
    const octx = off.getContext('2d'), img = octx.createImageData(s.columns, s.rows);
    const lo = state.wc - state.ww / 2, k = 255 / state.ww, inv = s.first.inverted;
    for (let i = 0, j = 0; i < px.length; i++, j += 4) {
      let v = (px[i] - lo) * k; v = v < 0 ? 0 : v > 255 ? 255 : v; if (inv) v = 255 - v;
      img.data[j] = img.data[j + 1] = img.data[j + 2] = v; img.data[j + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    const dpr = Math.min(window.devicePixelRatio || 1, 2), W = stage.clientWidth, H = stage.clientHeight;
    if (c2d.width !== W * dpr || c2d.height !== H * dpr) { c2d.width = W * dpr; c2d.height = H * dpr; }
    const ctx = c2d.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c2d.width, c2d.height);
    const wmm = s.columns * s.spacing[0], hmm = s.rows * s.spacing[1];
    const fit = Math.min(W / wmm, (H - 170) / hmm) * state.view2d.zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, W / 2 + state.view2d.x - wmm * fit / 2, (H - 40) / 2 + state.view2d.y - hmm * fit / 2, wmm * fit, hmm * fit);
    $('sliceOut').textContent = `${state.slice + 1}/${s.slices.length}`;
  } finally { drawing = false; if (drawAgain) { drawAgain = false; draw2d(); } }
}

// ---------- rendering ----------
const renderer = new THREE.WebGLRenderer({ canvas: c3d, alpha: true, antialias: false, powerPreference: 'high-performance' });
renderer.setClearColor(0x000000, 0);
const view = new VolumeView(renderer);
const pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: 1 };
const target = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: 1 };

function resize3d() {
  const W = stage.clientWidth, H = stage.clientHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, state.mode === 'cam' ? 1.25 : 1.0));
  renderer.setSize(W, H, false);
  layoutBox();
}
/** The fixed X-ray window, in screen px with the origin at the centre and y up. */
function windowBox() {
  const W = stage.clientWidth, H = stage.clientHeight;
  const bw = Math.min(W * 0.84, 460), bh = Math.min(H * 0.34, bw * 1.05), cy = -H * 0.07;
  return { x0: -bw / 2, x1: bw / 2, y0: cy - bh / 2, y1: cy + bh / 2 };
}
function layoutBox() {
  const b = windowBox(), W = stage.clientWidth, H = stage.clientHeight, el = $('box');
  el.style.left = `${W / 2 + b.x0}px`; el.style.top = `${H / 2 - b.y1}px`;
  el.style.width = `${b.x1 - b.x0}px`; el.style.height = `${b.y1 - b.y0}px`;
}
function poseMatrix(p) {
  return new THREE.Matrix4().compose(p.pos, p.quat, new THREE.Vector3(p.scale, p.scale, p.scale));
}
function modelMatrix() {
  if (state.mode === 'cam') {
    const p = { pos: pose.pos, quat: pose.quat, scale: pose.scale * state.userSize };
    return poseMatrix(p).multiply(anatomyMatrix(state.A.wrist, state.userSide !== state.side, state.widthFit));
  }
  const W = stage.clientWidth, H = stage.clientHeight, s = state.A.size, big = Math.max(s[0], s[1], s[2]);
  const fit = Math.min((H - 190) / big, W * 0.9 / big) * 1.25 * state.zoom3d;
  const p = { pos: new THREE.Vector3(state.pan3d.x, state.pan3d.y - 10, 0), quat: state.orbit, scale: fit };
  return poseMatrix(p).multiply(anatomyMatrix(state.A.center, false));
}

// ---------- labels: name what is inside the window ----------
const labelEls = [];
function updateLabels(model, box, show) {
  const host = $('labels'), W = stage.clientWidth, H = stage.clientHeight;
  const list = show && state.A ? state.A.labels : [];
  while (labelEls.length < list.length) { const d = document.createElement('div'); d.className = 'lbl'; host.append(d); labelEls.push(d); }
  const placed = [];
  labelEls.forEach((el, i) => {
    const L = list[i];
    if (!L || !model) { el.style.opacity = 0; return; }
    const p = new THREE.Vector3(...L.at).applyMatrix4(model);
    const inside = p.x > box.x0 + 12 && p.x < box.x1 - 12 && p.y > box.y0 + 12 && p.y < box.y1 - 12;
    const sx = W / 2 + p.x, sy = H / 2 - p.y;
    const clash = placed.some(([x, y]) => Math.abs(x - sx) < 90 && Math.abs(y - sy) < 18);
    if (!inside || clash) { el.style.opacity = 0; return; }
    placed.push([sx, sy]);
    el.textContent = L.name; el.style.left = `${sx}px`; el.style.top = `${sy}px`; el.style.opacity = state.fade.toFixed(2);
    el.style.transform = sx > W * 0.6 ? 'translate(calc(-100% + 8px),-50%)' : 'translate(-6px,-50%)';
  });
}
/** Which part of the arm the middle of the window is looking at. */
function regionUnderWindow(model, box) {
  const A = state.A; if (!A || !A.regions.length) return '';
  const inv = model.clone().invert(), cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const a = new THREE.Vector3(cx, cy, 1000).applyMatrix4(inv), b = new THREE.Vector3(cx, cy, -1000).applyMatrix4(inv);
  const d1 = b.sub(a), d2 = A.fingers, w0 = a.clone().sub(A.wrist);
  const aa = d1.dot(d1), bb = d1.dot(d2), cc = d2.dot(d2), dd = d1.dot(w0), ee = d2.dot(w0), den = aa * cc - bb * bb;
  if (Math.abs(den) < 1e-6) return '';
  const s = (bb * ee - cc * dd) / den, t = (aa * ee - bb * dd) / den;
  const gap = a.clone().addScaledVector(d1, s).distanceTo(A.wrist.clone().addScaledVector(d2, t));
  if (gap > 70) return 'Aim the window at your arm';
  const r = A.regions.find(([lo, hi]) => t >= lo && t < hi);
  return r ? r[2] : '';
}

// ---------- tracking ----------
function coverMap(W, H, sw, sh) {
  const k = Math.max(W / sw, H / sh), dw = sw * k, dh = sh * k, ox = (W - dw) / 2, oy = (H - dh) / 2;
  return { toScreen: (u, v) => [ox + u * dw - W / 2, H / 2 - (oy + v * dh)], toPic: (x, y) => [(x + W / 2 - ox) / dw, (H / 2 - y - oy) / dh] };
}
function poseFromHand(hand, W, H, sw, sh) {
  const map = coverMap(W, H, sw, sh);
  const P = (i) => map.toScreen(hand.image[i].x, hand.image[i].y);
  const w3 = (i) => new THREE.Vector3(hand.world[i].x, -hand.world[i].y, -hand.world[i].z);
  let num = 0, den = 0;
  for (const [a, b] of [[0, 5], [0, 17], [5, 17], [0, 9], [0, 13], [5, 13]]) {
    const pa = P(a), pb = P(b), wa = hand.world[a], wb = hand.world[b];
    num += Math.hypot(pa[0] - pb[0], pa[1] - pb[1]); den += Math.hypot(wa.x - wb.x, wa.y - wb.y);
  }
  if (den < 0.005) return null;
  // Size the scan so its own hand (wrist to middle knuckle) spans the same distance as the user's.
  const y = w3(9).sub(w3(0)); const unitsPerMm = y.length() / (state.A ? state.A.handLength : HAND_MM); y.normalize();
  const t = w3(5).sub(w3(17)); const x = t.addScaledVector(y, -t.dot(y)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  const p = P(0);
  return { pos: new THREE.Vector3(p[0], p[1], 0), quat: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)), scale: (num / den) * unitsPerMm };
}
const sample = document.createElement('canvas');
const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
/** Palm colour, and the direction the forearm leaves the wrist in the picture (screen, y up). */
function readSkinAndForearm(hand, source, sw, sh) {
  const k = 128 / Math.max(sw, sh), w = Math.max(8, Math.round(sw * k)), h = Math.max(8, Math.round(sh * k));
  if (sample.width !== w || sample.height !== h) { sample.width = w; sample.height = h; }
  sampleCtx.drawImage(source, 0, 0, w, h);
  let img; try { img = sampleCtx.getImageData(0, 0, w, h).data; } catch { return {}; }
  const pt = (i) => [hand.image[i].x * w, hand.image[i].y * h];
  const wrist = pt(0), mid = pt(9), hl = Math.hypot(mid[0] - wrist[0], mid[1] - wrist[1]);
  if (hl < 5) return {};
  let r0 = 0, g0 = 0, b0 = 0, n0 = 0;
  for (const [a, b, c] of [[0, 5, 17], [0, 9, 9], [0, 5, 9], [0, 13, 17], [5, 17, 0]]) {
    const A = pt(a), B = pt(b), C = pt(c), x = Math.round((A[0] + B[0] + C[0]) / 3), y = Math.round((A[1] + B[1] + C[1]) / 3);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = (y * w + x) * 4; r0 += img[i]; g0 += img[i + 1]; b0 += img[i + 2]; n0++;
  }
  if (!n0) return {};
  r0 /= n0; g0 /= n0; b0 /= n0;
  const skin = { cb: -0.169 * r0 - 0.331 * g0 + 0.5 * b0, cr: 0.5 * r0 - 0.419 * g0 - 0.081 * b0, y: 0.299 * r0 + 0.587 * g0 + 0.114 * b0 };
  const d = [(mid[0] - wrist[0]) / hl, (mid[1] - wrist[1]) / hl], back = [-d[0], -d[1]];
  const scan = (axis, band) => {
    let sx = 0, sy = 0, hits = 0, total = 0;
    const R = 2.2 * hl;
    for (let yy = Math.max(0, Math.floor(wrist[1] - R)); yy <= Math.min(h - 1, wrist[1] + R); yy++) for (let xx = Math.max(0, Math.floor(wrist[0] - R)); xx <= Math.min(w - 1, wrist[0] + R); xx++) {
      const vx = xx - wrist[0], vy = yy - wrist[1], r = Math.hypot(vx, vy);
      if (r < 0.5 * hl || r > R || vx * axis[0] + vy * axis[1] < 0.15 * hl) continue;
      if (band && Math.abs(vx * axis[1] - vy * axis[0]) > band * hl) continue;
      total++;
      const i = (yy * w + xx) * 4, rr = img[i], gg = img[i + 1], bb = img[i + 2], yv = 0.299 * rr + 0.587 * gg + 0.114 * bb;
      if (Math.abs(-0.169 * rr - 0.331 * gg + 0.5 * bb - skin.cb) < 13 && Math.abs(0.5 * rr - 0.419 * gg - 0.081 * bb - skin.cr) < 13 && yv > 0.35 * skin.y && yv < 1.9 * skin.y) { hits++; sx += vx; sy += vy; }
    }
    const len = Math.hypot(sx, sy);
    return { dir: len ? [sx / len, sy / len] : null, hits, frac: total ? hits / total : 0 };
  };
  const first = scan(back, 0);
  if (!first.dir || first.hits < 25 || first.frac < 0.08 || first.frac > 0.62) return { skin };
  const second = scan(first.dir, 0.75);
  const f = second.dir && second.hits >= 20 ? second.dir : first.dir;
  if (f[0] * back[0] + f[1] * back[1] < 0.55) return { skin };
  // Width of the forearm across its axis, at a few distances behind the wrist (in hand lengths).
  const isSkin = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const i = (y * w + x) * 4, rr = img[i], gg = img[i + 1], bb = img[i + 2], yv = 0.299 * rr + 0.587 * gg + 0.114 * bb;
    return Math.abs(-0.169 * rr - 0.331 * gg + 0.5 * bb - skin.cb) < 15 && Math.abs(0.5 * rr - 0.419 * gg - 0.081 * bb - skin.cr) < 15 && yv > 0.3 * skin.y && yv < 2 * skin.y;
  };
  const widths = [];
  const pxScreen = Math.max(stage.clientWidth / sw, stage.clientHeight / sh) / k;   // screen px per sample px
  for (const frac of state.A.sections.map((c) => c.d / state.A.handLength)) {
    const cx = wrist[0] + f[0] * hl * frac, cy = wrist[1] + f[1] * hl * frac;
    if (!isSkin(cx, cy)) { widths.push(null); continue; }
    const run = (sgn) => { let gap = 0, r = 0, last = 0; for (r = 0.5; r < 3 * hl; r += 0.5) { if (isSkin(cx - f[1] * r * sgn, cy + f[0] * r * sgn)) { last = r; gap = 0; } else if (++gap > 3) break; } return last; };
    const a = run(1), b = run(-1);
    // Reject a measurement that runs into the picture edge (arm cut off by the frame).
    const ex = (sg, r) => { const x = cx - f[1] * r * sg, y = cy + f[0] * r * sg; return x < 2 || y < 2 || x > w - 3 || y > h - 3; };
    widths.push(ex(1, a + 1) || ex(-1, b + 1) ? null : (a + b) * pxScreen);
  }
  return { skin, forearm: [f[0], -f[1]], widths };
}
function applyHand(hand, source) {
  const W = stage.clientWidth, H = stage.clientHeight;
  const sw = source.videoWidth || source.width || W, sh = source.videoHeight || source.height || H;
  const r = poseFromHand(hand, W, H, sw, sh);
  if (!r) return;
  const seen = readSkinAndForearm(hand, source, sw, sh);
  if (seen.skin) state.skin = seen.skin;
  if (seen.forearm) {
    const v = new THREE.Vector2(...seen.forearm);
    state.forearm = state.forearm ? state.forearm.lerp(v, 0.3).normalize() : v;
  } else state.forearm = null;
  if (state.forearm) {
    // Bent wrist: turn the scan so its forearm runs along the forearm seen in the picture.
    const rot = new THREE.Matrix4().extractRotation(anatomyMatrix(new THREE.Vector3(), state.userSide !== state.side));
    const a = state.A.forearm.clone().negate().applyMatrix4(rot).normalize().applyQuaternion(r.quat);
    if (Math.hypot(a.x, a.y) > 0.35) {
      const delta = Math.atan2(a.x * state.forearm.y - a.y * state.forearm.x, a.x * state.forearm.x + a.y * state.forearm.y);
      r.quat.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), delta));
    }
  }
  // Steady the size: median of recent measurements.
  state.scales.push(r.scale); if (state.scales.length > 9) state.scales.shift();
  const sorted = state.scales.slice().sort((a, b) => a - b);
  const steady = sorted[sorted.length >> 1];
  // Fit the width: compare the forearm's width in the picture with the scan's, across the same line.
  if (seen.widths && state.forearm && state.A.sections.length) {
    const rot = new THREE.Matrix4().extractRotation(anatomyMatrix(new THREE.Vector3(), state.userSide !== state.side)).premultiply(new THREE.Matrix4().makeRotationFromQuaternion(r.quat));
    const perp = new THREE.Vector3(-state.forearm.y, state.forearm.x, 0);
    const ratios = [];
    state.A.sections.forEach((sec, i) => {
      const seenW = seen.widths[i];
      if (!seenW) return;
      let lo = Infinity, hi = -Infinity;
      for (const p of sec.pts) { const q = p.clone().sub(state.A.wrist).applyMatrix4(rot).dot(perp); if (q < lo) lo = q; if (q > hi) hi = q; }
      const scanW = (hi - lo) * steady * state.userSize;
      if (scanW > 10) ratios.push(seenW / scanW);
    });
    if (ratios.length) {
      ratios.sort((a, b) => a - b);
      const want = clamp(ratios[ratios.length >> 1], 0.75, 1.45);
      state.widthFit += (want - state.widthFit) * 0.15;
    }
  }
  target.pos.copy(r.pos); target.quat.copy(r.quat); target.scale = steady;
  if (!state.locked) { pose.pos.copy(r.pos); pose.quat.copy(r.quat); pose.scale = r.scale; }
  state.locked = true; state.lastHand = state.lastGood = now();
}
/** Move the overlay with the picture between hand detections (camera close to the arm, hand out of view). */
function applyFlow(m, source) {
  const W = stage.clientWidth, H = stage.clientHeight;
  const map = coverMap(W, H, source.videoWidth || source.width, source.videoHeight || source.height);
  const c = map.toScreen(m.cx, m.cy), c2 = map.toScreen(m.cx + m.dx, m.cy + m.dy);
  const C = new THREE.Vector3(c[0], c[1], 0), D = new THREE.Vector3(c2[0] - c[0], c2[1] - c[1], 0);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -m.rot);
  for (const p of [pose, target]) {
    p.pos.sub(C).multiplyScalar(m.scale).applyQuaternion(q).add(C).add(D);
    p.quat.premultiply(q); p.scale *= m.scale;
  }
}
async function ensureTracker() {
  if (state.tracker || state.trackerState === 'loading') return;
  state.trackerState = 'loading';
  try { const { createHandTracker } = await import('./tracker.js'); state.tracker = await createHandTracker(); state.trackerState = 'ready'; }
  catch (e) { console.error(e); state.trackerState = 'failed'; }
}
async function startCamera() {
  if (state.testSource) { state.source = state.testSource; state.camOn = true; return; }
  if (state.camOn) return;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error(window.isSecureContext ? 'no camera access in this browser' : 'the page must be opened over https');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    video.srcObject = stream; await video.play();
    state.source = video; state.camOn = true; state.camError = '';
  } catch (e) {
    state.camError = e.name === 'NotAllowedError' ? 'Camera access was refused. Allow the camera for this site, then reload.' : `Camera unavailable: ${e.message}`;
  }
}
function stopCamera() {
  if (video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; }
  state.camOn = false;
}
function hintText() {
  if (state.mode !== 'cam' || !state.cur) return '';
  if (!state.vol) return 'This scan is a flat image. Use Slices to view it.';
  if (!state.trackable) return 'X-ray vision works with forearm and hand scans. Use 3D or Slices for this one.';
  if (state.camError) return state.camError;
  if (!state.camOn) return 'Starting camera…';
  if (state.trackerState === 'loading') return 'Getting ready…';
  if (state.trackerState === 'failed') return 'Tracking could not start on this device.';
  if (!state.xray) return '';
  if (now() - state.sizeShownAt < 1200) return `Size ${Math.round(state.userSize * 100)}%  ·  double-tap to reset`;
  if (!state.locked) return 'Show your hand and forearm to lock on';
  if (now() - state.lastGood > 1500) return 'Lost your arm. Show your hand again to re-lock';
  return '';
}

// ---------- main loop ----------
async function tick() {
  try {
    const W = stage.clientWidth, H = stage.clientHeight, t = now() / 1000;
    if (state.mode === 'cam' && state.A && state.trackable && state.camOn && !state.loading) {
      const src = state.source;
      // 1. Hand landmarks: absolute position, turn and size.
      let hand;
      if (state.tracker) hand = await state.tracker.detect(src);
      if (hand) applyHand(hand, src);
      // 2. Optical flow on the skin inside the window: keeps the lock when the hand is out of view.
      if (state.locked && (hand !== undefined || src !== video)) {
        const map = coverMap(W, H, src.videoWidth || src.width, src.videoHeight || src.height), b = windowBox();
        const p0 = map.toPic(b.x0, b.y1), p1 = map.toPic(b.x1, b.y0);
        const region = { cx: (p0[0] + p1[0]) / 2, cy: (p0[1] + p1[1]) / 2, rx: Math.abs(p1[0] - p0[0]) / 2, ry: Math.abs(p1[1] - p0[1]) / 2 };
        const m = state.flow.update(src, region, state.skin);
        if (m && !hand) applyFlow(m, src);
        if (m) state.lastGood = now();
      }
      if (state.locked && now() - state.lastHand < 250) {
        pose.pos.lerp(target.pos, 0.45); pose.quat.slerp(target.quat, 0.35);
        pose.scale += (target.scale - pose.scale) * 0.3;
      }
      const live = state.locked && now() - state.lastGood < 2500;
      state.fade += ((live && state.xray ? 1 : 0) - state.fade) * 0.18;
      renderer.clear();
      const box = windowBox();
      if (state.fade > 0.01) {
        const model = modelMatrix();
        view.render(model, box, W, H, { fade: state.fade, mode: state.style, time: t, frame: true });
        updateLabels(model, box, true);
        const r = regionUnderWindow(model, box);
        if ($('regionText').textContent !== r) $('regionText').textContent = r;
      } else { updateLabels(null, box, false); $('regionText').textContent = ''; }
      $('lock').style.display = state.xray && state.locked && now() - state.lastGood < 1500 ? 'block' : 'none';
    } else if (state.mode === '3d' && state.A) {
      renderer.clear();
      const model = modelMatrix(), box = { x0: -W / 2, x1: W / 2, y0: -H / 2, y1: H / 2 };
      state.fade = 1;
      view.render(model, box, W, H, { fade: 1, mode: state.style, time: t, frame: false });
      updateLabels(model, { x0: -W / 2 + 10, x1: W / 2 - 10, y0: -H / 2 + 120, y1: H / 2 - 60 }, true);
      $('lock').style.display = 'none';
    } else {
      updateLabels(null, windowBox(), false);
      $('lock').style.display = 'none';
    }
    const h = hintText();
    if ($('hintText').textContent !== h) $('hintText').textContent = h;
    $('hint').classList.toggle('off', !h);
  } catch (e) { console.error(e); }
  requestAnimationFrame(tick);
}

// ---------- modes & controls ----------
function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === mode);
  for (const c of document.querySelectorAll('#panel > div')) c.style.display = c.dataset.for === mode ? 'block' : 'none';
  $('panel').style.display = mode === 'cam' ? 'none' : 'block';
  $('dock').style.display = mode === 'cam' && state.trackable ? 'flex' : 'none';
  c2d.style.display = mode === '2d' ? 'block' : 'none';
  c3d.style.display = mode === '2d' ? 'none' : 'block';
  video.style.display = mode === 'cam' && !state.testSource ? 'block' : 'none';
  if (state.testSource) state.testSource.style.display = mode === 'cam' ? 'block' : 'none';
  syncButtons();
  if (mode === '2d') draw2d(); else resize3d();
  if (mode === 'cam') { startCamera(); if (state.trackable) ensureTracker(); }
  else stopCamera();
}
function syncButtons() {
  $('xrayBtn').classList.toggle('on', state.xray);
  $('xrayBtn').textContent = state.xray ? 'X-RAY ON' : 'X-RAY';
  $('styleBtn').textContent = state.style ? 'X-ray film' : 'Anatomy';
  $('flipBtn').textContent = state.userSide === 'left' ? 'Left arm' : 'Right arm';
  $('box').style.display = state.mode === 'cam' && state.xray && state.trackable ? 'block' : 'none';
  for (const b of $('view3d').children) b.classList.toggle('on', +b.dataset.style === state.style);
}
function buildViewChips() {
  const box = $('view3d'); box.innerHTML = '';
  for (const [label, s] of [['Anatomy', 0], ['X-ray film', 1]]) {
    const b = document.createElement('button'); b.textContent = label; b.dataset.style = s;
    b.onclick = () => { state.style = s; syncButtons(); };
    box.append(b);
  }
}
for (const b of document.querySelectorAll('#modes button')) b.onclick = () => state.cur && setMode(b.dataset.mode);
$('xrayBtn').onclick = () => { state.xray = !state.xray; syncButtons(); };
$('styleBtn').onclick = () => { state.style = state.style ? 0 : 1; syncButtons(); };
$('flipBtn').onclick = () => { state.userSide = state.userSide === 'left' ? 'right' : 'left'; syncButtons(); };
$('slice').oninput = (e) => { state.slice = +e.target.value; draw2d(); };
$('openBtn').onclick = () => $('sheet').classList.remove('hidden');
$('closeSheet').onclick = () => $('sheet').classList.add('hidden');
$('pickBtn').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const list = [...e.target.files];
  if (!list.length) return;
  busy('Reading files…');
  const items = [];
  for (const f of list) items.push({ name: f.name, buffer: await f.arrayBuffer() });
  e.target.value = '';
  loadBuffers(items);
};
async function loadSample(url) {
  busy('Downloading scan…');
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`sample not found (${r.status})`);
    await loadBuffers([{ name: url, buffer: await r.arrayBuffer() }], 'CT: Visible Human Project, courtesy of the U.S. National Library of Medicine');
  } catch (e) { busy(''); $('err').textContent = `Could not download the scan: ${e.message}`; $('sheet').classList.remove('hidden'); }
}
for (const b of document.querySelectorAll('[data-sample]')) b.onclick = () => loadSample(b.dataset.sample);

// ---------- touch (3D and Slices; the camera view needs none) ----------
const pts = new Map();
let last = null;
function summary() {
  const a = [...pts.values()];
  if (a.length === 1) return { n: 1, x: a[0].x, y: a[0].y };
  const dx = a[1].x - a[0].x, dy = a[1].y - a[0].y;
  return { n: 2, x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, dist: Math.hypot(dx, dy), ang: Math.atan2(dy, dx) };
}
let lastTap = 0;
stage.addEventListener('pointerdown', (e) => {
  stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = summary();
  if (state.mode === 'cam' && pts.size === 1) {
    if (now() - lastTap < 320) { state.userSize = 1; state.widthFit = 1; state.scales = []; state.sizeShownAt = now(); }
    lastTap = now();
  }
});
const up = (e) => { pts.delete(e.pointerId); last = pts.size ? summary() : null; };
stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
stage.addEventListener('pointermove', (e) => {
  if (!pts.has(e.pointerId) || !state.cur) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const cur = summary();
  if (!last || last.n !== cur.n) { last = cur; return; }
  const dx = cur.x - last.x, dy = cur.y - last.y, pinch = cur.n === 2 && last.dist > 0 ? cur.dist / last.dist : 1;
  let twist = cur.n === 2 ? cur.ang - last.ang : 0;
  if (twist > Math.PI) twist -= 2 * Math.PI; else if (twist < -Math.PI) twist += 2 * Math.PI;
  last = cur;
  if (state.mode === 'cam' && cur.n === 2 && state.xray) {
    state.userSize = clamp(state.userSize * pinch, 0.6, 1.6); state.sizeShownAt = now();
    return;
  }
  if (state.mode === '2d') {
    const v = state.view2d;
    v.zoom = clamp(v.zoom * pinch, 0.5, 12); v.x = (v.x + dx) * (cur.n === 2 ? pinch : 1); v.y = (v.y + dy) * (cur.n === 2 ? pinch : 1);
    draw2d();
  } else if (state.mode === '3d') {
    if (cur.n === 1) state.orbit.premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(dy * 0.008, dx * 0.008, 0, 'XYZ')));
    else {
      state.zoom3d = clamp(state.zoom3d * pinch, 0.3, 12); state.pan3d.x += dx; state.pan3d.y -= dy;
      state.orbit.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -twist));
    }
  }
});
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const k = Math.exp(-e.deltaY * 0.0015);
  if (state.mode === '2d') { state.view2d.zoom = clamp(state.view2d.zoom * k, 0.5, 12); draw2d(); }
  else if (state.mode === '3d') state.zoom3d = clamp(state.zoom3d * k, 0.3, 12);
}, { passive: false });
window.addEventListener('resize', () => { if (state.mode === '2d') draw2d(); else resize3d(); });

// Test hooks: lets automated checks feed a still picture in place of the camera.
window.__xrv = {
  state, pose, target, loadBuffers, loadSample, setMode, modelMatrix, windowBox, applyFlow, THREE,
  useTestSource(el) {
    el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none';
    stage.insertBefore(el, c2d); state.testSource = el;
  },
};
resize3d();
tick();
if (!new URLSearchParams(location.search).has('noauto')) loadSample(DEFAULT_SAMPLE);
