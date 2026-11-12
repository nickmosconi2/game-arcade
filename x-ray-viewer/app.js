// X-ray Viewer: hold your arm up to the camera, switch on X-RAY, and look into it through a window:
// bones, muscles, tendons, arteries and veins, posed bone by bone to match your own hand.
import * as THREE from './vendor/three.module.min.js';
import { loadArm, ArmView, KIND_STYLE } from './anatomy.js';
import { handPoints, solveArm, posedJoints, FINGER_SEGS } from './rig.js';
import { createFlowTracker } from './flow.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), video = $('video'), c3d = $('c3d');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const now = () => performance.now();

const LAYERS = [
  { label: 'All layers', show: { bone: true, artery: true, vein: true, muscle: true } },
  { label: 'Vessels + bone', show: { bone: true, artery: true, vein: true, muscle: false } },
  { label: 'Bone only', show: { bone: true, artery: false, vein: false, muscle: false } },
];

const state = {
  mode: 'cam', arms: {}, arm: null, side: 'left', sideAuto: true,
  xray: false, film: false, layer: 0, labels: true,
  camOn: false, camError: '', source: null, testSource: null,
  tracker: null, trackerState: 'off', flow: createFlowTracker(), skin: null,
  locked: false, lastHand: 0, lastGood: 0, fade: 0,
  P: null, delta: 0, forearm: null, forearmWidth: null, sideVotes: [],
  orbit: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, -0.5, 0)), zoom3d: 1, pan3d: new THREE.Vector2(),
};

// ---------- rendering ----------
const renderer = new THREE.WebGLRenderer({ canvas: c3d, alpha: true, antialias: true, powerPreference: 'high-performance' });
renderer.setClearColor(0x000000, 0);
const view = new ArmView(renderer);

function resize() {
  const W = stage.clientWidth, H = stage.clientHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(W, H, false);
  layoutBox();
}
function windowBox() {
  const W = stage.clientWidth, H = stage.clientHeight;
  const bw = Math.min(W * 0.86, 480), bh = Math.min(H * 0.36, bw * 1.1), cy = -H * 0.06;
  return { x0: -bw / 2, x1: bw / 2, y0: cy - bh / 2, y1: cy + bh / 2 };
}
function layoutBox() {
  const b = windowBox(), W = stage.clientWidth, H = stage.clientHeight, el = $('box');
  el.style.left = `${W / 2 + b.x0}px`; el.style.top = `${H / 2 - b.y1}px`;
  el.style.width = `${b.x1 - b.x0}px`; el.style.height = `${b.y1 - b.y0}px`;
}

// ---------- model ----------
async function useSide(side) {
  state.side = side;
  if (!state.arms[side]) {
    $('busyText').textContent = 'Loading anatomy…'; $('busy').classList.remove('hidden');
    try { state.arms[side] = await loadArm(side); } catch (e) { console.error(e); $('busyText').textContent = `Could not load the model: ${e.message}`; return; }
    $('busy').classList.add('hidden');
  }
  state.arm = state.arms[side];
  view.setArm(state.arm);
  applyLayers();
  syncButtons();
}
function applyLayers() {
  view.visible = { ...LAYERS[state.layer].show, tissue: false };
  if (state.mode === '3d') view.visible = { ...chips3d };
}
const chips3d = { bone: true, artery: true, vein: true, muscle: true, tissue: false };

// ---------- camera & tracking ----------
function coverMap(W, H, sw, sh) {
  const k = Math.max(W / sw, H / sh), dw = sw * k, dh = sh * k, ox = (W - dw) / 2, oy = (H - dh) / 2;
  return { k, toScreen: (u, v) => [ox + u * dw - W / 2, H / 2 - (oy + v * dh)], toPic: (x, y) => [(x + W / 2 - ox) / dw, (H / 2 - y - oy) / dh] };
}
const sample = document.createElement('canvas');
const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
/** Palm colour; direction and width of the forearm in the picture (screen px, y up). */
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
  const isSkin = (x, y, tol = 14) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const i = (y * w + x) * 4, rr = img[i], gg = img[i + 1], bb = img[i + 2], yv = 0.299 * rr + 0.587 * gg + 0.114 * bb;
    return Math.abs(-0.169 * rr - 0.331 * gg + 0.5 * bb - skin.cb) < tol && Math.abs(0.5 * rr - 0.419 * gg - 0.081 * bb - skin.cr) < tol && yv > 0.3 * skin.y && yv < 2 * skin.y;
  };
  const d = [(mid[0] - wrist[0]) / hl, (mid[1] - wrist[1]) / hl], back = [-d[0], -d[1]];
  const scan = (axis, band) => {
    let sx = 0, sy = 0, hits = 0, total = 0;
    const R = 2.2 * hl;
    for (let yy = Math.max(0, Math.floor(wrist[1] - R)); yy <= Math.min(h - 1, wrist[1] + R); yy++) for (let xx = Math.max(0, Math.floor(wrist[0] - R)); xx <= Math.min(w - 1, wrist[0] + R); xx++) {
      const vx = xx - wrist[0], vy = yy - wrist[1], r = Math.hypot(vx, vy);
      if (r < 0.5 * hl || r > R || vx * axis[0] + vy * axis[1] < 0.15 * hl) continue;
      if (band && Math.abs(vx * axis[1] - vy * axis[0]) > band * hl) continue;
      total++;
      if (isSkin(xx, yy, 13)) { hits++; sx += vx; sy += vy; }
    }
    const len = Math.hypot(sx, sy);
    return { dir: len ? [sx / len, sy / len] : null, hits, frac: total ? hits / total : 0 };
  };
  const first = scan(back, 0);
  if (!first.dir || first.hits < 25 || first.frac < 0.08 || first.frac > 0.62) return { skin };
  const second = scan(first.dir, 0.75);
  const f = second.dir && second.hits >= 20 ? second.dir : first.dir;
  if (f[0] * back[0] + f[1] * back[1] < 0.55) return { skin };
  // forearm width one hand-length behind the wrist
  const cx = wrist[0] + f[0] * hl, cy = wrist[1] + f[1] * hl;
  let width = null;
  if (isSkin(cx, cy)) {
    const run = (sg) => { let gap = 0, last = 0; for (let r = 0.5; r < 3 * hl; r += 0.5) { if (isSkin(cx - f[1] * r * sg, cy + f[0] * r * sg)) { last = r; gap = 0; } else if (++gap > 3) break; } return last; };
    const a = run(1), b = run(-1);
    const edge = (sg, r) => { const x = cx - f[1] * r * sg, y = cy + f[0] * r * sg; return x < 2 || y < 2 || x > w - 3 || y > h - 3; };
    if (!edge(1, a + 1) && !edge(-1, b + 1)) width = (a + b) * Math.max(stage.clientWidth / sw, stage.clientHeight / sh) / k;
  }
  return { skin, forearm: new THREE.Vector2(f[0], -f[1]), width };
}

function onHand(hand, src) {
  const W = stage.clientWidth, H = stage.clientHeight, sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
  const map = coverMap(W, H, sw, sh);
  // Which arm: MediaPipe's handedness, held steady over a few frames; the button overrides it.
  if (state.sideAuto && hand.score > 0.8) {
    state.sideVotes.push(hand.label === 'Right' ? 'right' : 'left'); if (state.sideVotes.length > 12) state.sideVotes.shift();
    const r = state.sideVotes.filter((v) => v === 'right').length;
    const want = r >= 9 ? 'right' : r <= 3 ? 'left' : state.side;
    if (want !== state.side && state.sideVotes.length >= 8) useSide(want);
  }
  const { P } = handPoints(hand, map.toScreen);
  if (!state.P || now() - state.lastHand > 600) state.P = P;
  else state.P = state.P.map((p, i) => p.lerp(P[i], 0.55));
  const seen = readSkinAndForearm(hand, src, sw, sh);
  if (seen.skin) state.skin = seen.skin;
  if (seen.forearm) state.forearm = state.forearm ? state.forearm.lerp(seen.forearm, 0.3).normalize() : seen.forearm;
  else state.forearm = null;
  if (seen.width) state.forearmWidth = state.forearmWidth ? state.forearmWidth + (seen.width - state.forearmWidth) * 0.2 : seen.width;
  if (!state.arm) return;
  const r = solveArm(state.arm, state.P, state.forearm, state.delta);
  state.delta = r.delta; state.scale = r.scale;
  view.seg.forEach((m, i) => m.copy(r.seg[i]));
  state.locked = true; state.lastHand = state.lastGood = now();
}
/** Hand out of view (phone close to the forearm): move everything with the picture. */
function onFlow(m, src) {
  const W = stage.clientWidth, H = stage.clientHeight;
  const map = coverMap(W, H, src.videoWidth || src.width, src.videoHeight || src.height);
  const c = map.toScreen(m.cx, m.cy), c2 = map.toScreen(m.cx + m.dx, m.cy + m.dy);
  const D = new THREE.Matrix4().makeTranslation(c2[0], c2[1], 0)
    .multiply(new THREE.Matrix4().makeRotationZ(-m.rot))
    .multiply(new THREE.Matrix4().makeScale(m.scale, m.scale, m.scale))
    .multiply(new THREE.Matrix4().makeTranslation(-c[0], -c[1], 0));
  for (const s of view.seg) s.premultiply(D);
  if (state.P) state.P.forEach((p) => p.applyMatrix4(D));
  state.scale *= m.scale;
  if (state.forearmWidth) state.forearmWidth *= m.scale;
}

/** Outline of the user's arm, from the posed model joints, as shapes for the opening mask. */
function armShapes() {
  const W = stage.clientWidth, H = stage.clientHeight, s = state.scale || 1;
  // The opening follows the user's real hand (tracked points); the forearm comes from the model.
  const J = state.P || posedJoints(state.arm, view.seg);
  const css = (v) => [W / 2 + v.x, H / 2 - v.y];
  const caps = [], polys = [];
  const fw = { 2: 20, 3: 18, 4: 16 };
  for (const [seg, a, b] of FINGER_SEGS) {
    const w = (fw[seg] || (seg % 3 === 2 ? 17 : seg % 3 === 0 ? 15 : 13)) * s * 0.85;
    const A = css(J[a]), B = css(J[b]); caps.push([...A, ...B, w]);
  }
  polys.push([0, 1, 2, 5, 9, 13, 17].map((i) => css(J[i])));
  caps.push([...css(J[0]), ...css(J[9]), 45 * s]);
  // forearm: from the wrist toward the elbow, as wide as measured (or a typical forearm)
  const wr = J[0].clone(), el = state.arm.elbow.clone().applyMatrix4(view.seg[0]);
  const dir = el.clone().sub(wr); dir.z = 0; const len = dir.length(); dir.normalize();
  const perp = new THREE.Vector3(-dir.y, dir.x, 0);
  const w0 = (state.forearmWidth || 58 * s) * 0.5 * 0.9, w1 = w0 * 1.25;
  const far = wr.clone().addScaledVector(dir, Math.max(len * 1.3, 2000));
  polys.push([wr.clone().addScaledVector(perp, w0), far.clone().addScaledVector(perp, w1), far.clone().addScaledVector(perp, -w1), wr.clone().addScaledVector(perp, -w0)].map(css));
  return { caps, polys };
}

async function ensureTracker() {
  if (state.tracker || state.trackerState === 'loading') return;
  state.trackerState = 'loading';
  try { const { createHandTracker } = await import('./tracker.js'); state.tracker = await createHandTracker(); state.trackerState = 'ready'; }
  catch (e) { console.error(e); state.trackerState = 'failed'; }
}
async function startCamera() {
  if (state.testSource) { state.source = state.testSource; state.camOn = true; state.camError = ''; return; }
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

// ---------- labels ----------
const PRIORITY = { bone: 3, artery: 2, vein: 1, muscle: 0 };
function shortName(n) {
  return n.replace(/\b(left|right)\b\s*/gi, '').replace(/ of (the )?(hand|wrist|forearm)$/i, '').replace(/^Set of /, '').replace(/\s+bone$/, '').replace(/^./, (c) => c.toUpperCase());
}
const labelEls = [];
function updateLabels(box, show, inMask) {
  const host = $('labels'), W = stage.clientWidth, H = stage.clientHeight;
  const cands = [];
  if (show && state.arm && state.labels) {
    for (const p of state.arm.parts) {
      if (!view.visible[p.kind] || PRIORITY[p.kind] === undefined) continue;
      if (state.film && p.kind !== 'bone') continue;
      const q = p.center.clone().applyMatrix4(view.seg[p.seg]);
      if (q.x < box.x0 + 14 || q.x > box.x1 - 14 || q.y < box.y0 + 14 || q.y > box.y1 - 14) continue;
      if (inMask && !inMask(q)) continue;
      const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
      cands.push({ p, q, score: PRIORITY[p.kind] * 1000 + q.z - Math.hypot(q.x - cx, q.y - cy) * 0.5 });
    }
    cands.sort((a, b) => b.score - a.score);
  }
  const placed = [];
  for (const c of cands) {
    if (placed.length >= 6) break;
    const sx = W / 2 + c.q.x, sy = H / 2 - c.q.y;
    if (placed.some((o) => Math.abs(o.sx - sx) < 150 && Math.abs(o.sy - sy) < 24)) continue;
    if (placed.some((o) => shortName(o.c.p.name) === shortName(c.p.name))) continue;
    placed.push({ sx, sy, c });
  }
  while (labelEls.length < placed.length) { const d = document.createElement('div'); d.className = 'lbl'; host.append(d); labelEls.push(d); }
  labelEls.forEach((el, i) => {
    const pl = placed[i];
    if (!pl) { el.style.opacity = 0; return; }
    el.textContent = shortName(pl.c.p.name);
    el.dataset.kind = pl.c.p.kind;
    el.style.left = `${pl.sx}px`; el.style.top = `${pl.sy}px`; el.style.opacity = state.mode === '3d' ? 1 : state.fade.toFixed(2);
    el.style.transform = pl.sx > W * 0.6 ? 'translate(calc(-100% + 8px),-50%)' : 'translate(-6px,-50%)';
  });
  // caption: the bone nearest the middle of the window
  if (state.mode === 'cam') {
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    let best = null, bd = Infinity;
    if (show && state.arm) for (const p of state.arm.parts) {
      if (p.kind !== 'bone') continue;
      const q = p.center.clone().applyMatrix4(view.seg[p.seg]), d = Math.hypot(q.x - cx, q.y - cy);
      if (d < bd) { bd = d; best = p; }
    }
    const txt = best && bd < (box.x1 - box.x0) * 0.6 ? shortName(best.name) : '';
    if ($('regionText').textContent !== txt) $('regionText').textContent = txt;
  }
}

// ---------- main loop ----------
function hintText() {
  if (state.mode !== 'cam') return '';
  if (state.camError) return state.camError;
  if (!state.camOn) return 'Starting camera…';
  if (!state.xray) return '';
  if (state.trackerState === 'loading') return 'Getting ready…';
  if (state.trackerState === 'failed') return 'Tracking could not start on this device.';
  if (!state.locked) return 'Hold up your hand and forearm to lock on';
  if (now() - state.lastGood > 1500) return 'Lost your arm. Show your hand again';
  return '';
}
async function tick() {
  try {
    const W = stage.clientWidth, H = stage.clientHeight, t = now() / 1000;
    if (state.mode === 'cam' && state.camOn && state.arm) {
      const src = state.source;
      let hand;
      if (state.tracker && state.xray) hand = await state.tracker.detect(src);
      if (hand) onHand(hand, src);
      if (state.locked && state.xray && (hand !== undefined || src !== video)) {
        const map = coverMap(W, H, src.videoWidth || src.width, src.videoHeight || src.height), b = windowBox();
        const p0 = map.toPic(b.x0, b.y1), p1 = map.toPic(b.x1, b.y0);
        const m = state.flow.update(src, { cx: (p0[0] + p1[0]) / 2, cy: (p0[1] + p1[1]) / 2, rx: Math.abs(p1[0] - p0[0]) / 2, ry: Math.abs(p1[1] - p0[1]) / 2 }, state.skin);
        if (m && !hand) onFlow(m, src);
        if (m) state.lastGood = now();
      }
      const live = state.locked && now() - state.lastGood < 2500;
      state.fade += ((live && state.xray ? 1 : 0) - state.fade) * 0.2;
      renderer.clear();
      const box = windowBox();
      if (state.fade > 0.01) {
        view.paintMask(W, H, box, armShapes());
        const mc = view.maskCanvas, sc = mc.width / W, md = mc.getContext('2d').getImageData(0, 0, mc.width, mc.height).data;
        const inMask = (q) => { const x = Math.round((W / 2 + q.x) * sc), y = Math.round((H / 2 - q.y) * sc); return x >= 0 && y >= 0 && x < mc.width && y < mc.height && md[(y * mc.width + x) * 4] > 140; };
        view.render(W, H, box, { mask: true, xray: state.film, fade: state.fade, time: t });
        updateLabels(box, true, inMask);
      } else { updateLabels(box, false); $('regionText').textContent = ''; }
      $('lock').style.display = state.xray && state.locked && now() - state.lastGood < 1500 ? 'block' : 'none';
    } else if (state.mode === '3d' && state.arm) {
      renderer.clear();
      pose3d(W, H);
      const box = { x0: -W / 2, x1: W / 2, y0: -H / 2, y1: H / 2 };
      view.render(W, H, box, { mask: false, xray: state.film, fade: 1, time: t, cavity: false });
      updateLabels({ x0: -W / 2 + 10, x1: W / 2 - 10, y0: -H / 2 + 110, y1: H / 2 - 70 }, true);
      $('lock').style.display = 'none';
    } else { renderer.clear(); updateLabels(windowBox(), false); }
    const h = hintText();
    if ($('hintText').textContent !== h) $('hintText').textContent = h;
    $('hint').classList.toggle('off', !h);
  } catch (e) { console.error(e); }
  requestAnimationFrame(tick);
}
/** 3D view: the model in its rest pose, centred on the hand, turned by touch. */
function pose3d(W, H) {
  const J = state.arm.joints, c = J[0].clone().lerp(J[9], 0.2).lerp(state.arm.elbow, 0.25);
  const span = J[12].distanceTo(state.arm.elbow) * 1.05;
  const k = Math.min((H - 200) / span, (W * 0.95) / (span * 0.45)) * state.zoom3d;
  // stand the arm up: hand at the top
  const up = new THREE.Matrix4().makeRotationZ(Math.PI);
  const M = new THREE.Matrix4().makeTranslation(state.pan3d.x, state.pan3d.y + 20, 0)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(state.orbit)).multiply(up)
    .multiply(new THREE.Matrix4().makeScale(k, k, k)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
  view.seg.forEach((m) => m.copy(M));
}

// ---------- controls ----------
function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === mode);
  $('dock').style.display = mode === 'cam' ? 'flex' : 'none';
  $('panel').style.display = mode === '3d' ? 'block' : 'none';
  video.style.display = mode === 'cam' && !state.testSource ? 'block' : 'none';
  if (state.testSource) state.testSource.style.display = mode === 'cam' ? 'block' : 'none';
  c3d.style.display = 'block';
  applyLayers(); syncButtons(); resize();
  if (mode === 'cam') { startCamera(); ensureTracker(); }
  else stopCamera();
}
function syncButtons() {
  $('xrayBtn').classList.toggle('on', state.xray);
  $('xrayBtn').textContent = state.xray ? 'X-RAY ON' : 'X-RAY';
  $('styleBtn').textContent = state.film ? 'X-ray film' : 'Anatomy';
  $('layerBtn').textContent = LAYERS[state.layer].label;
  $('sideBtn').textContent = `${state.side === 'left' ? 'Left' : 'Right'} arm${state.sideAuto ? '' : ' ✓'}`;
  $('box').style.display = state.mode === 'cam' && state.xray ? 'block' : 'none';
  $('labelBtn').classList.toggle('on', state.labels);
  for (const b of $('chips').children) b.classList.toggle('on', !!chips3d[b.dataset.kind]);
}
for (const b of document.querySelectorAll('#modes button')) b.onclick = () => setMode(b.dataset.mode);
$('xrayBtn').onclick = () => { state.xray = !state.xray; if (!state.xray) { state.locked = false; state.flow.reset(); } syncButtons(); };
$('styleBtn').onclick = () => { state.film = !state.film; syncButtons(); };
$('labelBtn').onclick = () => { state.labels = !state.labels; syncButtons(); };
$('layerBtn').onclick = () => { state.layer = (state.layer + 1) % LAYERS.length; applyLayers(); syncButtons(); };
$('sideBtn').onclick = () => { state.sideAuto = false; useSide(state.side === 'left' ? 'right' : 'left'); };
for (const [kind, label] of [['bone', 'Bones'], ['muscle', 'Muscles'], ['artery', 'Arteries'], ['vein', 'Veins']]) {
  const b = document.createElement('button'); b.textContent = label; b.dataset.kind = kind;
  b.onclick = () => { chips3d[kind] = !chips3d[kind]; applyLayers(); syncButtons(); };
  $('chips').append(b);
}

// touch: rotate / zoom in 3D
const pts = new Map(); let last = null;
const summary = () => { const a = [...pts.values()]; if (a.length === 1) return { n: 1, x: a[0].x, y: a[0].y }; const dx = a[1].x - a[0].x, dy = a[1].y - a[0].y; return { n: 2, x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, dist: Math.hypot(dx, dy) }; };
stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = summary(); });
const up = (e) => { pts.delete(e.pointerId); last = pts.size ? summary() : null; };
stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
stage.addEventListener('pointermove', (e) => {
  if (!pts.has(e.pointerId) || state.mode !== '3d') return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const cur = summary();
  if (!last || last.n !== cur.n) { last = cur; return; }
  const dx = cur.x - last.x, dy = cur.y - last.y;
  if (cur.n === 1) state.orbit.premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(dy * 0.008, dx * 0.008, 0, 'XYZ')));
  else { state.zoom3d = clamp(state.zoom3d * (cur.dist / last.dist), 0.4, 8); state.pan3d.x += dx; state.pan3d.y -= dy; }
  last = cur;
});
stage.addEventListener('wheel', (e) => { e.preventDefault(); if (state.mode === '3d') state.zoom3d = clamp(state.zoom3d * Math.exp(-e.deltaY * 0.0015), 0.4, 8); }, { passive: false });
window.addEventListener('resize', resize);

window.__xrv = {
  state, view, setMode, useSide, THREE, windowBox,
  useTestSource(el) { el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none'; stage.insertBefore(el, c3d); state.testSource = el; state.camOn = false; if (state.mode === 'cam') { video.style.display = 'none'; el.style.display = 'block'; startCamera(); } },
};
resize();
useSide('left').then(() => setMode('cam'));
tick();
