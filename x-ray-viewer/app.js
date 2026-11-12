// X-ray Vision: point the phone at any part of your body, switch on X-RAY, and look into it through
// a window: bones, organs, muscles, vessels and nerves of a reference body, posed to match yours.
import * as THREE from './vendor/three.module.min.js';
import { loadBody, ArmView, GROUP } from './anatomy.js';
import { SEG, screenPoints, HAND_PAIRS, POSE_PAIRS, solveHand, solveBody, hideAll, FINGER_SEGS } from './rig.js';
import { createFlowTracker } from './flow.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), video = $('video'), c3d = $('c3d');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const now = () => performance.now();

const LAYERS = [
  { label: 'All layers', show: { bone: true, organ: true, artery: true, vein: true, nerve: true, muscle: true } },
  { label: 'Organs + vessels', show: { bone: true, organ: true, artery: true, vein: true, nerve: true, muscle: false } },
  { label: 'Bone only', show: { bone: true, organ: false, artery: false, vein: false, nerve: false, muscle: false } },
];
const chips3d = { bone: true, muscle: true, organ: true, artery: true, vein: true, nerve: true };

const state = {
  mode: 'cam', model: null,
  xray: false, film: false, layer: 0, labels: true,
  camOn: false, camError: '', source: null, testSource: null,
  hands: null, pose: null, trackerState: 'off', flow: createFlowTracker(), skin: null,
  locked: false, lastPose: 0, lastHand: { left: 0, right: 0 }, lastGood: 0, fade: 0, frame: 0,
  poseP: null, handP: { left: null, right: null }, delta: { left: 0, right: 0 },
  forearm: null, forearmWidth: null, outline: null, scale: 1,
  orbit: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, -0.35, 0)), zoom3d: 1, pan3d: new THREE.Vector2(),
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
function applyLayers() {
  view.visible = state.mode === '3d' ? { ...chips3d, tissue: false } : { ...LAYERS[state.layer].show, tissue: false };
}

// ---------- camera picture helpers ----------
function coverMap(W, H, sw, sh) {
  const k = Math.max(W / sw, H / sh), dw = sw * k, dh = sh * k, ox = (W - dw) / 2, oy = (H - dh) / 2;
  return { k, ox, oy, dw, dh, toScreen: (u, v) => [ox + u * dw - W / 2, H / 2 - (oy + v * dh)], toPic: (x, y) => [(x + W / 2 - ox) / dw, (H / 2 - y - oy) / dh] };
}
const small = document.createElement('canvas'), smallCtx = small.getContext('2d', { willReadFrequently: true });
/** Downscaled copy of the camera frame for body tracking (faster, and gives a small outline mask). */
function smallFrame(src) {
  const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height, w = 256, h = Math.round(256 * sh / sw);
  if (small.width !== w || small.height !== h) { small.width = w; small.height = h; }
  smallCtx.drawImage(src, 0, 0, w, h);
  return small;
}
/** Palm colour; direction and width of the forearm in the picture (screen px, y up). */
function readSkinAndForearm(hand, img, w, h, pxScreen) {
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
  const isSkin = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const i = (y * w + x) * 4, rr = img[i], gg = img[i + 1], bb = img[i + 2], yv = 0.299 * rr + 0.587 * gg + 0.114 * bb;
    return Math.abs(-0.169 * rr - 0.331 * gg + 0.5 * bb - skin.cb) < 14 && Math.abs(0.5 * rr - 0.419 * gg - 0.081 * bb - skin.cr) < 14 && yv > 0.3 * skin.y && yv < 2 * skin.y;
  };
  const d = [(mid[0] - wrist[0]) / hl, (mid[1] - wrist[1]) / hl], back = [-d[0], -d[1]];
  let sx = 0, sy = 0, hits = 0, total = 0;
  const R = 2.2 * hl;
  for (let yy = Math.max(0, Math.floor(wrist[1] - R)); yy <= Math.min(h - 1, wrist[1] + R); yy++) for (let xx = Math.max(0, Math.floor(wrist[0] - R)); xx <= Math.min(w - 1, wrist[0] + R); xx++) {
    const vx = xx - wrist[0], vy = yy - wrist[1], r = Math.hypot(vx, vy);
    if (r < 0.5 * hl || r > R || vx * back[0] + vy * back[1] < 0.15 * hl) continue;
    total++; if (isSkin(xx, yy)) { hits++; sx += vx; sy += vy; }
  }
  const len = Math.hypot(sx, sy);
  if (!len || hits < 25 || hits / total < 0.08 || hits / total > 0.62) return { skin };
  const f = [sx / len, sy / len];
  if (f[0] * back[0] + f[1] * back[1] < 0.55) return { skin };
  const cx = wrist[0] + f[0] * hl, cy = wrist[1] + f[1] * hl;
  let width = null;
  if (isSkin(cx, cy)) {
    const run = (sg) => { let gap = 0, last = 0; for (let r = 0.5; r < 3 * hl; r += 0.5) { if (isSkin(cx - f[1] * r * sg, cy + f[0] * r * sg)) { last = r; gap = 0; } else if (++gap > 3) break; } return last; };
    const a = run(1), b = run(-1);
    const edge = (sg, r) => { const x = cx - f[1] * r * sg, y = cy + f[0] * r * sg; return x < 2 || y < 2 || x > w - 3 || y > h - 3; };
    if (!edge(1, a + 1) && !edge(-1, b + 1)) width = (a + b) * pxScreen;
  }
  return { skin, forearm: new THREE.Vector2(f[0], -f[1]), width };
}

// ---------- tracking ----------
function onPose(res, src, W, H) {
  const map = coverMap(W, H, src.videoWidth || src.width, src.videoHeight || src.height);
  const P = screenPoints(res.image, res.world, map.toScreen, POSE_PAIRS);
  state.poseP = state.poseP && now() - state.lastPose < 500 ? state.poseP.map((p, i) => p.lerp(P[i], 0.6)) : P;
  state.vis = res.vis;
  const tracked = { left: now() - state.lastHand.left < 300, right: now() - state.lastHand.right < 300 };
  const r = solveBody(state.model, state.poseP, res.vis, view.seg, tracked);
  if (!r) return false;
  state.scale = r.scale;
  if (res.mask) {
    // Body outline as an image whose alpha is "this is the person", placed over the picture.
    const { data, w, h } = res.mask, c = state.outlineCanvas || (state.outlineCanvas = document.createElement('canvas'));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const x = c.getContext('2d'), im = x.createImageData(w, h);
    for (let i = 0, j = 3; i < data.length; i++, j += 4) { im.data[j - 3] = im.data[j - 2] = im.data[j - 1] = 255; im.data[j] = data[i] > 0.5 ? 255 : data[i] * 400; }
    x.putImageData(im, 0, 0);
    state.outline = { canvas: c, x: map.ox, y: map.oy, w: map.dw, h: map.dh, M: new DOMMatrix() };
  }
  state.lastPose = state.lastGood = now(); state.locked = true;
  return true;
}
function onHand(hand, src, W, H, img, iw, ih) {
  const side = hand.label === 'Right' ? 'right' : 'left';
  const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height, map = coverMap(W, H, sw, sh);
  const P = screenPoints(hand.image, hand.world, map.toScreen, HAND_PAIRS);
  state.handP[side] = state.handP[side] && now() - state.lastHand[side] < 500 ? state.handP[side].map((p, i) => p.lerp(P[i], 0.55)) : P;
  const seen = img ? readSkinAndForearm(hand, img, iw, ih, map.k * sw / iw) : {};
  if (seen.skin) state.skin = seen.skin;
  if (seen.forearm) state.forearm = state.forearm ? state.forearm.lerp(seen.forearm, 0.3).normalize() : seen.forearm;
  if (seen.width) state.forearmWidth = state.forearmWidth ? state.forearmWidth + (seen.width - state.forearmWidth) * 0.2 : seen.width;
  const poseFresh = now() - state.lastPose < 400;
  if (!poseFresh && !state.handOnly) { hideAll(view.seg); }
  state.handOnly = !poseFresh;
  const r = solveHand(state.model, side, state.handP[side], view.seg, { withForearm: !poseFresh, forearmDir: seen.forearm || null, prevDelta: state.delta[side] });
  state.delta[side] = r.delta; if (!poseFresh) state.scale = r.scale;
  state.lastHand[side] = state.lastGood = now(); state.locked = true;
}
/** Nothing detected (phone close to the skin): move everything with the picture. */
function onFlow(m, src, W, H) {
  const map = coverMap(W, H, src.videoWidth || src.width, src.videoHeight || src.height);
  const c = map.toScreen(m.cx, m.cy), c2 = map.toScreen(m.cx + m.dx, m.cy + m.dy);
  const D = new THREE.Matrix4().makeTranslation(c2[0], c2[1], 0).multiply(new THREE.Matrix4().makeRotationZ(-m.rot))
    .multiply(new THREE.Matrix4().makeScale(m.scale, m.scale, m.scale)).multiply(new THREE.Matrix4().makeTranslation(-c[0], -c[1], 0));
  for (const s of view.seg) s.premultiply(D);
  for (const k of ['left', 'right']) if (state.handP[k]) state.handP[k].forEach((p) => p.applyMatrix4(D));
  if (state.poseP) state.poseP.forEach((p) => p.applyMatrix4(D));
  state.scale *= m.scale;
  if (state.forearmWidth) state.forearmWidth *= m.scale;
  if (state.outline) {
    // same move in CSS px (top-left origin, y down): rotation sign flips with the y axis
    const cx = W / 2 + c[0], cy = H / 2 - c[1], dx = (W / 2 + c2[0]) - cx, dy = (H / 2 - c2[1]) - cy;
    const D2 = new DOMMatrix().translate(cx + dx, cy + dy).rotate(m.rot * 180 / Math.PI).scale(m.scale).translate(-cx, -cy);
    state.outline.M = D2.multiply(state.outline.M);
  }
}

/** Where to open the skin: the body outline (from body tracking) plus the tracked hands. */
function openingShapes(W, H) {
  const caps = [], polys = [], s = state.scale || 1;
  const css = (v) => [W / 2 + v.x, H / 2 - v.y];
  for (const side of ['left', 'right']) {
    const J = state.handP[side];
    if (!J || now() - state.lastHand[side] > 2500) continue;
    const hs = J[0].distanceTo(J[9]) / 85;   // px per mm from the hand itself
    for (const [f, a, b] of FINGER_SEGS) caps.push([...css(J[a]), ...css(J[b]), (f < 3 ? 19 : 16) * hs]);
    polys.push([0, 1, 2, 5, 9, 13, 17].map((i) => css(J[i])));
    caps.push([...css(J[0]), ...css(J[9]), 45 * hs]);
    if (state.handOnly) {
      // forearm, from the wrist toward the elbow as placed by the solver
      const i = side === 'left' ? 0 : 1, el = state.model.pose[13 + i].clone().applyMatrix4(view.seg[SEG.forearm[i]]);
      const wr = J[0].clone(), dir = el.clone().sub(wr); dir.z = 0; const len = dir.length(); dir.normalize();
      const perp = new THREE.Vector3(-dir.y, dir.x, 0), w0 = (state.forearmWidth || 58 * hs) * 0.45, w1 = w0 * 1.25;
      const far = wr.clone().addScaledVector(dir, Math.max(len * 1.3, 2000));
      polys.push([wr.clone().addScaledVector(perp, w0), far.clone().addScaledVector(perp, w1), far.clone().addScaledVector(perp, -w1), wr.clone().addScaledVector(perp, -w0)].map(css));
    }
  }
  void s;
  return { caps, polys };
}

let trackersStarting = false;
async function ensureTrackers() {
  if (trackersStarting || state.trackerState === 'ready') return;
  trackersStarting = true; state.trackerState = 'loading';
  try {
    const t = await import('./tracker.js');
    [state.hands, state.pose] = await Promise.all([t.createHandTracker(), t.createPoseTracker()]);
    state.trackerState = 'ready';
  } catch (e) { console.error(e); state.trackerState = 'failed'; }
  trackersStarting = false;
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
function stopCamera() { if (video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; } state.camOn = false; }

// ---------- naming what you are looking at ----------
const PRIORITY = { organ: 4, bone: 3, artery: 2, nerve: 2, vein: 1, muscle: 0 };
// Everyday names for organ parts, so "Wall of ventricle" reads as "Heart".
const FRIENDLY = [
  [/ventric|atri(um|al)|heart|myocard|valve|chordae|papillary|pericard/i, 'Heart'],
  [/lung|lobe of (left|right) lung|bronch/i, 'Lung'], [/trachea/i, 'Windpipe (trachea)'], [/esophag|oesophag/i, 'Esophagus'],
  [/liver|hepat/i, 'Liver'], [/gallbladder/i, 'Gallbladder'], [/stomach|gastric/i, 'Stomach'], [/spleen/i, 'Spleen'], [/pancrea/i, 'Pancreas'],
  [/small intestine|jejun|ileum|duoden|mesentery/i, 'Small intestine'], [/colon|cecum|caecum|rectum|appendix|large intestine/i, 'Large intestine'],
  [/kidney|renal/i, 'Kidney'], [/urinary bladder|ureter|urethra/i, 'Bladder and ureters'], [/adrenal|suprarenal/i, 'Adrenal gland'],
  [/thymus/i, 'Thymus'], [/thyroid gland/i, 'Thyroid'], [/pharyn|palat|tongue|glossus|larynx|epiglott/i, "Throat"], [/cerebr|cerebell|brain|gyrus|lobe of brain|hippocamp|thalam|pons|medulla oblongata|midbrain/i, 'Brain'],
  [/spinal cord/i, 'Spinal cord'], [/eyeball|sclera|cornea|lens|iris|retina|vitreous|choroid|ciliar|ocular/i, 'Eye'],
  [/intervertebral dis[ck]/i, 'Spinal disc'], [/costal cartilage/i, 'Rib cartilage'],
];
function shortName(n) {
  if (!/bone|muscle|artery|vein|nerve|ligament/i.test(n)) for (const [re, name] of FRIENDLY) if (re.test(n)) return name;
  return n.replace(/\b(left|right)\b\s*/gi, '').replace(/ of (the )?(hand|wrist|forearm)$/i, '').replace(/^Set of /, '').replace(/\s+bone$/, '').replace(/^./, (c) => c.toUpperCase());
}
const MINOR = /disk|disc|cartilage|gingiva|tooth|ligament|retinaculum|sesamoid|ossicle|tendinous ring|lacrimal|canaliculus/i;
function regionOf(p) {
  const s = p.seg, J = state.model.pose, side = s % 2 === 0 ? 'Left' : 'Right';
  if (s === 0) {
    const sy = (J[11].y + J[12].y) / 2, hy = (J[23].y + J[24].y) / 2, y = p.center.y;
    return y > sy + 20 ? 'Neck' : y > hy + (sy - hy) * 0.55 ? 'Chest' : y > hy + (sy - hy) * 0.12 ? 'Abdomen' : 'Pelvis';
  }
  if (s === 1) return 'Head';
  if (s >= 14) return `${s < 29 ? 'Left' : 'Right'} ${(s - 14) % 15 < 3 ? 'thumb' : 'finger'}`;
  return `${side} ${['', '', 'upper arm', 'upper arm', 'forearm', 'forearm', 'hand', 'hand', 'thigh', 'thigh', 'lower leg', 'lower leg', 'foot', 'foot'][s]}`;
}
const labelEls = [];
function posedCenter(p) { return p.center.clone().applyMatrix4(view.seg[p.seg]); }
function isShown(m) { return m.elements[0] !== 0 || m.elements[5] !== 0; }
function updateLabels(box, show, inMask) {
  const host = $('labels'), W = stage.clientWidth, H = stage.clientHeight;
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const cands = [];
  let best = null, bestScore = -Infinity;
  if (show && state.model) {
    for (const p of state.model.parts) {
      const g = GROUP(p.kind);
      if (!view.visible[g] || PRIORITY[g] === undefined || !isShown(view.seg[p.seg])) continue;
      if (state.film && g !== 'bone') continue;
      const q = posedCenter(p);
      if (q.x < box.x0 + 14 || q.x > box.x1 - 14 || q.y < box.y0 + 14 || q.y > box.y1 - 14) continue;
      if (inMask && !inMask(q)) continue;
      const size = Math.log(1 + p.v[1]) - (MINOR.test(p.name) ? 3 : 0);
      const d = Math.hypot(q.x - cx, q.y - cy);
      const score = PRIORITY[g] * 3 + size - d / 60;
      cands.push({ p, q, score });
      const capScore = (g === 'organ' ? 6 : g === 'bone' ? 5 : 0) + size * 0.5 - d / 40;
      if ((g === 'organ' || g === 'bone') && capScore > bestScore) { bestScore = capScore; best = p; }
    }
    cands.sort((a, b) => b.score - a.score);
  }
  const placed = [];
  if (state.labels) for (const c of cands) {
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
    el.textContent = shortName(pl.c.p.name); el.dataset.kind = GROUP(pl.c.p.kind);
    el.style.left = `${pl.sx}px`; el.style.top = `${pl.sy}px`; el.style.opacity = state.mode === '3d' ? 1 : state.fade.toFixed(2);
    el.style.transform = pl.sx > W * 0.6 ? 'translate(calc(-100% + 8px),-50%)' : 'translate(-6px,-50%)';
  });
  if (state.mode === 'cam') {
    const txt = best ? `${regionOf(best)} · ${shortName(best.name)}` : '';
    if ($('regionText').textContent !== txt) $('regionText').textContent = txt;
  }
}

// ---------- main loop ----------
function hintText() {
  if (state.mode !== 'cam') return '';
  if (state.camError) return state.camError;
  if (!state.camOn) return 'Starting camera…';
  if (!state.model) return 'Loading anatomy…';
  if (!state.xray) return '';
  if (state.trackerState === 'loading') return 'Getting ready…';
  if (state.trackerState === 'failed') return 'Tracking could not start on this device.';
  if (!state.locked) return 'Point the camera at yourself or someone else';
  if (now() - state.lastGood > 1500) return 'Lost the body. Step back a little';
  return '';
}
async function tick() {
  try {
    const W = stage.clientWidth, H = stage.clientHeight, t = now() / 1000;
    if (state.mode === 'cam' && state.camOn && state.model) {
      const src = state.source;
      let found = false;
      if (state.xray && state.trackerState === 'ready' && (src !== video || src.readyState >= 2)) {
        state.frame++;
        const sm = smallFrame(src);
        if (state.frame % 2 === 0) {
          const res = await state.pose.detect(sm);
          if (res) found = onPose(res, src, W, H) || found;
        } else {
          const hands = await state.hands.detect(src);
          if (hands.length) {
            const img = smallCtx.getImageData(0, 0, sm.width, sm.height).data;
            for (const h of hands) onHand(h, src, W, H, img, sm.width, sm.height);
            found = true;
          }
        }
        // Optical flow keeps the lock when nothing is detected (camera close to the skin).
        if (state.locked) {
          const map = coverMap(W, H, src.videoWidth || src.width, src.videoHeight || src.height), b = windowBox();
          const p0 = map.toPic(b.x0, b.y1), p1 = map.toPic(b.x1, b.y0);
          const m = state.flow.update(src, { cx: (p0[0] + p1[0]) / 2, cy: (p0[1] + p1[1]) / 2, rx: Math.abs(p1[0] - p0[0]) / 2, ry: Math.abs(p1[1] - p0[1]) / 2 }, state.skin);
          const stale = now() - Math.max(state.lastPose, state.lastHand.left, state.lastHand.right) > 250;
          if (m && stale && !found) { onFlow(m, src, W, H); state.lastGood = now(); }
        }
      }
      const live = state.locked && now() - state.lastGood < 2500;
      state.fade += ((live && state.xray ? 1 : 0) - state.fade) * 0.2;
      renderer.clear();
      const box = windowBox();
      if (state.fade > 0.01) {
        const outline = state.outline && now() - state.lastGood < 2500 ? state.outline : null;
        view.paintMask(W, H, box, openingShapes(W, H), outline);
        const mc = view.maskCanvas, sc = mc.width / W, md = mc.getContext('2d').getImageData(0, 0, mc.width, mc.height).data;
        const inMask = (q) => { const x = Math.round((W / 2 + q.x) * sc), y = Math.round((H / 2 - q.y) * sc); return x >= 0 && y >= 0 && x < mc.width && y < mc.height && md[(y * mc.width + x) * 4] > 140; };
        view.render(W, H, box, { mask: true, xray: state.film, fade: state.fade, time: t });
        updateLabels(box, true, inMask);
      } else { updateLabels(box, false); $('regionText').textContent = ''; }
      $('lock').style.display = state.xray && state.locked && now() - state.lastGood < 1500 ? 'block' : 'none';
    } else if (state.mode === '3d' && state.model) {
      renderer.clear();
      pose3d(W, H);
      view.render(W, H, { x0: -W / 2, x1: W / 2, y0: -H / 2, y1: H / 2 }, { mask: false, xray: state.film, fade: 1, time: t, cavity: false });
      updateLabels({ x0: -W / 2 + 10, x1: W / 2 - 10, y0: -H / 2 + 110, y1: H / 2 - 70 }, true);
      $('lock').style.display = 'none';
    } else { renderer.clear(); updateLabels(windowBox(), false); }
    const h = hintText();
    if ($('hintText').textContent !== h) $('hintText').textContent = h;
    $('hint').classList.toggle('off', !h);
  } catch (e) { console.error(e); }
  requestAnimationFrame(tick);
}
/** 3D view: the whole body in its rest pose, turned by touch. */
function pose3d(W, H) {
  const J = state.model.pose, top = J[0].y + 120, bottom = J[31].y;
  const c = new THREE.Vector3(0, (top + bottom) / 2, 0);
  const k = Math.min((H - 200) / (top - bottom), W * 0.9 / 700) * state.zoom3d;
  const M = new THREE.Matrix4().makeTranslation(state.pan3d.x, state.pan3d.y - 20, 0)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(state.orbit))
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
  if (mode === 'cam') { startCamera(); ensureTrackers(); } else stopCamera();
}
function syncButtons() {
  $('xrayBtn').classList.toggle('on', state.xray);
  $('xrayBtn').textContent = state.xray ? 'X-RAY ON' : 'X-RAY';
  $('styleBtn').textContent = state.film ? 'X-ray film' : 'Anatomy';
  $('layerBtn').textContent = LAYERS[state.layer].label;
  $('labelBtn').classList.toggle('on', state.labels);
  $('box').style.display = state.mode === 'cam' && state.xray ? 'block' : 'none';
  for (const b of $('chips').children) b.classList.toggle('on', !!chips3d[b.dataset.kind]);
}
for (const b of document.querySelectorAll('#modes button')) b.onclick = () => setMode(b.dataset.mode);
$('xrayBtn').onclick = () => { state.xray = !state.xray; if (!state.xray) { state.locked = false; state.flow.reset(); } syncButtons(); };
$('styleBtn').onclick = () => { state.film = !state.film; syncButtons(); };
$('layerBtn').onclick = () => { state.layer = (state.layer + 1) % LAYERS.length; applyLayers(); syncButtons(); };
$('labelBtn').onclick = () => { state.labels = !state.labels; syncButtons(); };
for (const [kind, label] of [['bone', 'Bones'], ['muscle', 'Muscles'], ['organ', 'Organs'], ['artery', 'Arteries'], ['vein', 'Veins'], ['nerve', 'Nerves']]) {
  const b = document.createElement('button'); b.textContent = label; b.dataset.kind = kind;
  b.onclick = () => { chips3d[kind] = !chips3d[kind]; applyLayers(); syncButtons(); };
  $('chips').append(b);
}
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
  else { state.zoom3d = clamp(state.zoom3d * (cur.dist / last.dist), 0.4, 12); state.pan3d.x += dx; state.pan3d.y -= dy; }
  last = cur;
});
stage.addEventListener('wheel', (e) => { e.preventDefault(); if (state.mode === '3d') state.zoom3d = clamp(state.zoom3d * Math.exp(-e.deltaY * 0.0015), 0.4, 12); }, { passive: false });
window.addEventListener('resize', resize);

window.__xrv = {
  state, view, setMode, THREE, windowBox,
  useTestSource(el) { el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none'; stage.insertBefore(el, c3d); state.testSource = el; state.camOn = false; if (state.mode === 'cam') { video.style.display = 'none'; el.style.display = 'block'; startCamera(); } },
};
resize();
setMode('cam');
(async () => {
  $('busy').classList.remove('hidden');
  try {
    state.model = await loadBody('models', (f) => { $('busyText').textContent = `Loading anatomy… ${Math.round(f * 100)}%`; });
    view.setModel(state.model); applyLayers();
  } catch (e) { console.error(e); $('busyText').textContent = `Could not load the anatomy: ${e.message}`; return; }
  $('busy').classList.add('hidden');
})();
tick();
