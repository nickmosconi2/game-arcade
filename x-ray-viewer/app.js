// X-ray Vision: point the phone at any part of your body, switch on X-RAY, and look into it through
// a window: bones, organs, muscles, vessels and nerves of a reference body, posed to match yours.
import * as THREE from './vendor/three.module.min.js';
import { loadBody, ArmView, GROUP } from './anatomy.js';
import { SEG, SEG_COUNT, screenPoints, HAND_PAIRS, POSE_PAIRS, solveHand, solveBody, hideAll, FINGER_SEGS, HAND_SEGS, BODY_SEGS } from './rig.js';
import { createFlowTracker } from './flow.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), video = $('video'), c3d = $('c3d');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const now = () => performance.now();

const LAYERS = [
  { label: 'Bone only', hud: 'BONE', show: { bone: true, organ: false, artery: false, vein: false, nerve: false, muscle: false } },
  { label: 'Organs + vessels', hud: 'ORGANS · VESSELS', show: { bone: true, organ: true, artery: true, vein: true, nerve: true, muscle: false } },
  { label: 'All layers', hud: 'ALL TISSUE', show: { bone: true, organ: true, artery: true, vein: true, nerve: true, muscle: true } },
];

/** One-euro filter over a list of points: steady when still, quick when moving (less jitter). */
class Smoother {
  constructor(minCut = 1.4, beta = 0.012) { this.minCut = minCut; this.beta = beta; this.x = null; this.dx = null; this.t = 0; }
  reset() { this.x = null; }
  filter(P, t) {
    if (!this.x || this.x.length !== P.length || t - this.t > 0.5) { this.x = P.map((p) => p.clone()); this.dx = P.map(() => new THREE.Vector3()); this.t = t; return this.x.map((p) => p.clone()); }
    const dt = Math.max(1 / 120, t - this.t); this.t = t;
    const a = (cut) => 1 / (1 + 1 / (2 * Math.PI * cut * dt));
    const ad = a(1.0);
    for (let i = 0; i < P.length; i++) {
      const d = P[i].clone().sub(this.x[i]).divideScalar(dt);
      this.dx[i].lerp(d, ad);
      this.x[i].lerp(P[i], a(this.minCut + this.beta * this.dx[i].length()));
    }
    return this.x.map((p) => p.clone());
  }
}
const chips3d = { bone: true, muscle: true, organ: true, artery: true, vein: true, nerve: true };

const state = {
  mode: 'cam', model: null,
  xray: false, film: true, layer: 0, labels: true, facing: 'environment', mirror: false,
  move: null, moveState: 'off', limbP: null, limbVis: null, poseFrom: '', sweepT0: 0, wasLive: false,
  smooth: { pose: new Smoother(), move: new Smoother(1.0, 0.01), left: new Smoother(), right: new Smoother() }, caption: { text: '', cand: '', since: 0 },
  camOn: false, camError: '', source: null, testSource: null,
  hands: null, pose: null, trackerState: 'off', flow: createFlowTracker(), skin: null,
  on: 0, xrayAt: 0, lastMP: 0, locked: false, lastPose: 0, lastHand: { left: 0, right: 0 }, lastGood: 0, fade: 0, frame: 0,
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
// Every bone group (segment) has a target placement from the latest detection, and a shown placement
// that glides toward it. A segment appears only after it has been seen in several detections in a
// row and fades out when it has not been seen for a moment, so nothing pops in, jumps, or lingers.
const N = SEG_COUNT;
const trk = {
  tgt: Array.from({ length: N }, () => new THREE.Matrix4()), want: new Array(N).fill(false),
  seen: new Array(N).fill(0), streak: new Array(N).fill(0),
  cur: Array.from({ length: N }, () => new THREE.Matrix4()),
  a: view.segA, lastT: 0, flowSince: 0,
};
trk.a.fill(0);
const HIDDEN_M = new THREE.Matrix4().makeScale(0, 0, 0);
/** After a solver ran: count the streak of each segment it is responsible for. */
function commit(owned) {
  const t = now();
  for (const s of owned) { if (trk.want[s]) { trk.seen[s] = t; trk.streak[s]++; } else trk.streak[s] = 0; }
}
function stepSegments(t) {
  const dt = Math.min(0.1, Math.max(0.001, (t - (trk.lastT || t)) / 1000)); trk.lastT = t;
  const k = 1 - Math.exp(-dt * 16), fadeIn = 1 - Math.exp(-dt * 9), fadeOut = 1 - Math.exp(-dt * 7);
  let any = false;
  for (let s = 0; s < N; s++) {
    const recent = t - trk.seen[s] < 350, sure = trk.streak[s] >= 3 || (trk.a[s] > 0.5 && recent);
    const target = recent && sure ? 1 : 0;
    const cur = trk.cur[s].elements, tg = trk.tgt[s].elements;
    if (trk.a[s] < 0.02 && target) trk.cur[s].copy(trk.tgt[s]);            // appear in place
    else if (target) for (let i = 0; i < 16; i++) cur[i] += (tg[i] - cur[i]) * k;
    trk.a[s] += (target - trk.a[s]) * (target ? fadeIn : fadeOut);
    if (!target && trk.a[s] < 0.02) trk.a[s] = 0;
    if (trk.a[s] > 0) { view.seg[s].copy(trk.cur[s]); any = true; } else view.seg[s].copy(HIDDEN_M);
  }
  return any;
}
const segShown = (s) => trk.a[s] > 0.5;

/** Hand-vs-body sanity check: a "body" no bigger than the tracked hand is a false detection. */
function handLengthPx() {
  let L = 0;
  for (const k of ['left', 'right']) {
    const J = state.handP[k];
    if (J && now() - state.lastHand[k] < 700) L = Math.max(L, Math.hypot(J[0].x - J[9].x, J[0].y - J[9].y), Math.hypot(J[5].x - J[17].x, J[5].y - J[17].y) * 1.3);
  }
  return L;
}
function bodyTooSmall(P, ok, hl) {
  if (!hl) return false;
  const d = (a, b) => (ok(a) && ok(b) ? Math.hypot(P[a].x - P[b].x, P[a].y - P[b].y) : 0);
  const big = Math.max(d(11, 12) / 3.4, d(23, 24) / 2.6, d(11, 23) / 4.5, d(12, 24) / 4.5, d(11, 13) / 2.8, d(12, 14) / 2.8,
    d(13, 15) / 2.4, d(14, 16) / 2.4, d(23, 25) / 4.0, d(24, 26) / 4.0, d(25, 27) / 3.6, d(26, 28) / 3.6);
  return big < 0.55 * hl;
}
function onPose(res, src, W, H) {
  const map = coverMap(W, H, src.videoWidth || src.width, src.videoHeight || src.height);
  // points outside the picture are guesses: never trust them
  const vis = res.vis.map((v, i) => { const p = res.image[i]; return p.x < 0.01 || p.x > 0.99 || p.y < 0.01 || p.y > 0.99 ? 0 : v; });
  const loose = res.vis.map((v, i) => { const p = res.image[i]; return p.x < -0.2 || p.x > 1.2 || p.y < -0.2 || p.y > 1.2 ? 0 : v; });
  const P = screenPoints(res.image, res.world, map.toScreen, POSE_PAIRS);
  if (bodyTooSmall(P, (i) => vis[i] > 0.5, handLengthPx())) { commit(BODY_SEGS); return false; }
  state.poseP = state.smooth.pose.filter(P, now() / 1000);
  state.vis = vis; state.lastMP = now();
  const r = solveBody(state.model, state.poseP, vis, trk.tgt, trk.want, { loose });
  commit(BODY_SEGS);
  if (!r) return false;
  state.scale = r.scale;
  if (res.mask) {
    // Body outline as an image whose alpha is "this is the person", placed over the picture.
    const { data, w, h } = res.mask, c = state.outlineCanvas || (state.outlineCanvas = document.createElement('canvas'));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const x = c.getContext('2d'), im = x.createImageData(w, h);
    for (let i = 0, j = 3; i < data.length; i++, j += 4) { im.data[j - 3] = im.data[j - 2] = im.data[j - 1] = 255; im.data[j] = data[i] > 0.5 ? 255 : data[i] * 400; }
    x.putImageData(im, 0, 0);
    state.outline = { canvas: c, x: map.ox, y: map.oy, w: map.dw, h: map.dh, M: new DOMMatrix(), t: now() };
  }
  state.lastPose = state.lastGood = now(); state.locked = true;
  return true;
}

// Hands are followed by position (two slots), and each slot's left/right is decided by a running
// vote, so a single mislabelled frame can't swap the skeleton to the other hand.
const slots = [];
function onHands(hands, src, W, H, img, iw, ih) {
  const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height, map = coverMap(W, H, sw, sh);
  let list = hands.filter((h) => h.score > 0.6).map((h) => ({ h, P: screenPoints(h.image, h.world, map.toScreen, HAND_PAIRS) }));
  // the same hand reported twice: keep the surer one
  list.sort((x, y) => y.h.score - x.h.score);
  list = list.filter((x, i) => !list.slice(0, i).some((y) => x.P[0].distanceTo(y.P[0]) < 0.6 * y.P[0].distanceTo(y.P[9])));
  const t = now();
  for (const sl of slots) sl.used = false;
  for (const x of list) {
    const hl = x.P[0].distanceTo(x.P[9]);
    let best = null, bd = 2.5 * hl;
    for (const sl of slots) if (!sl.used && t - sl.last < 800) { const d = sl.P[0].distanceTo(x.P[0]); if (d < bd) { bd = d; best = sl; } }
    if (!best) { best = { vote: 0, side: null, smooth: new Smoother(), last: 0 }; slots.push(best); }
    best.used = true; best.last = t;
    best.vote = best.vote * 0.75 + (x.h.label === 'Right' ? 0.25 : -0.25);
    const want = best.vote >= 0 ? 'right' : 'left';
    if (!best.side || (want !== best.side && Math.abs(best.vote) > 0.45)) best.side = want;
    best.P = best.smooth.filter(x.P, t / 1000); best.hand = x.h;
  }
  for (let i = slots.length - 1; i >= 0; i--) if (t - slots[i].last > 800) slots.splice(i, 1);
  const live = slots.filter((sl) => sl.used);
  if (live.length === 2 && live[0].side === live[1].side) { const w = Math.abs(live[0].vote) < Math.abs(live[1].vote) ? live[0] : live[1]; w.side = w.side === 'left' ? 'right' : 'left'; }
  const done = { left: false, right: false };
  for (const sl of live) {
    const side = sl.side, i = side === 'left' ? 0 : 1;
    state.handP[side] = sl.P; state.lastHand[side] = t; done[side] = true;
    const seen = img ? readSkinAndForearm(sl.hand, img, iw, ih, map.k * sw / iw) : {};
    if (seen.skin) state.skin = seen.skin;
    if (seen.forearm) state.forearm = state.forearm ? state.forearm.lerp(seen.forearm, 0.3).normalize() : seen.forearm;
    else state.forearm = null;
    if (seen.width) state.forearmWidth = state.forearmWidth ? state.forearmWidth + (seen.width - state.forearmWidth) * 0.2 : seen.width;
    // forearm from the hand only when the body tracker isn't placing it, and only along a forearm seen in the picture
    const bodyArm = t - trk.seen[SEG.forearm[i]] < 350 && trk.streak[SEG.forearm[i]] > 0;
    for (const s of HAND_SEGS(i)) trk.want[s] = false;
    if (!bodyArm) trk.want[SEG.forearm[i]] = false;
    const r = solveHand(state.model, side, sl.P, trk.tgt, trk.want, { withForearm: !bodyArm, forearmDir: seen.forearm || null });
    commit(bodyArm ? HAND_SEGS(i) : [...HAND_SEGS(i), SEG.forearm[i]]);
    if (!bodyArm) state.scale = r.scale;
  }
  for (const side of ['left', 'right']) if (!done[side]) { const i = side === 'left' ? 0 : 1; for (const s of HAND_SEGS(i)) trk.want[s] = false; commit(HAND_SEGS(i)); }
  state.handOnly = now() - state.lastPose > 600;
  if (live.length) { state.lastGood = t; state.locked = true; }
  return live.length > 0;
}
/** Nothing detected (phone close to the skin): move what is shown with the picture, briefly. */
function onFlow(m, src, W, H) {
  const map = coverMap(W, H, src.videoWidth || src.width, src.videoHeight || src.height);
  const c = map.toScreen(m.cx, m.cy), c2 = map.toScreen(m.cx + m.dx, m.cy + m.dy);
  const D = new THREE.Matrix4().makeTranslation(c2[0], c2[1], 0).multiply(new THREE.Matrix4().makeRotationZ(-m.rot))
    .multiply(new THREE.Matrix4().makeScale(m.scale, m.scale, m.scale)).multiply(new THREE.Matrix4().makeTranslation(-c[0], -c[1], 0));
  const t = now();
  for (let s = 0; s < N; s++) if (trk.a[s] > 0) { trk.tgt[s].premultiply(D); trk.seen[s] = t; }
  for (const k of ['left', 'right']) if (state.handP[k]) state.handP[k].forEach((p) => p.applyMatrix4(D));
  for (const sl of slots) if (sl.P) sl.P.forEach((p) => p.applyMatrix4(D));
  if (state.poseP) state.poseP.forEach((p) => p.applyMatrix4(D));
  state.scale *= m.scale;
  if (state.forearmWidth) state.forearmWidth *= m.scale;
  if (state.outline) {
    const cx = W / 2 + c[0], cy = H / 2 - c[1], dx = (W / 2 + c2[0]) - cx, dy = (H / 2 - c2[1]) - cy;
    const D2 = new DOMMatrix().translate(cx + dx, cy + dy).rotate(m.rot * 180 / Math.PI).scale(m.scale).translate(-cx, -cy);
    state.outline.M = D2.multiply(state.outline.M);
  }
}

/** Where the skin turns see-through: the body outline (from body tracking) plus the tracked hands. */
function openingShapes(W, H) {
  const caps = [], polys = [];
  const css = (v) => [W / 2 + v.x, H / 2 - v.y];
  for (const side of ['left', 'right']) {
    const J = state.handP[side], i = side === 'left' ? 0 : 1;
    if (!J || !segShown(SEG.hand[i])) continue;
    const hs = J[0].distanceTo(J[9]) / 85;   // px per mm from the hand itself
    for (const [f, a, b] of FINGER_SEGS) caps.push([...css(J[a]), ...css(J[b]), (f < 3 ? 19 : 16) * hs]);
    polys.push([0, 1, 2, 5, 9, 13, 17].map((i2) => css(J[i2])));
    caps.push([...css(J[0]), ...css(J[9]), 45 * hs]);
    if (state.handOnly && segShown(SEG.forearm[i])) {
      const el = state.model.pose[13 + i].clone().applyMatrix4(view.seg[SEG.forearm[i]]);
      const wr = J[0].clone(), dir = el.clone().sub(wr); dir.z = 0; const len = dir.length(); dir.normalize();
      const perp = new THREE.Vector3(-dir.y, dir.x, 0), w0 = (state.forearmWidth || 58 * hs) * 0.45, w1 = w0 * 1.25;
      const far = wr.clone().addScaledVector(dir, Math.max(len * 1.3, 2000));
      polys.push([wr.clone().addScaledVector(perp, w0), far.clone().addScaledVector(perp, w1), far.clone().addScaledVector(perp, -w1), wr.clone().addScaledVector(perp, -w0)].map(css));
    }
  }
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
let camBusy = false;
async function startCamera() {
  if (state.testSource) { state.source = state.testSource; state.camOn = true; state.camError = ''; view.setSource(state.testSource); applyMirror(); return; }
  if (state.camOn || camBusy) return;
  camBusy = true;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error(window.isSecureContext ? 'no camera access in this browser' : 'the page must be opened over https');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: state.facing }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    video.srcObject = stream; await video.play();
    const set = stream.getVideoTracks()[0]?.getSettings?.() || {};
    state.mirror = (set.facingMode || state.facing) === 'user';
    state.source = video; state.camOn = true; state.camError = '';
    view.setSource(video); applyMirror();
  } catch (e) {
    state.camError = e.name === 'NotAllowedError' ? 'Camera access was refused. Allow the camera for this site, then reload.' : `Camera unavailable: ${e.message}`;
  }
  camBusy = false;
}
/** Selfie camera: the picture and the anatomy drawn over it are shown mirrored, like a mirror. */
function applyMirror() { stage.classList.toggle('mirror', state.mode === 'cam' && state.mirror); }
function resetTracking() {
  state.locked = false; state.flow.reset(); state.outline = null; state.poseP = null; state.handP = { left: null, right: null };
  for (const k of Object.keys(state.smooth)) state.smooth[k].reset();
  slots.length = 0; trk.a.fill(0); trk.streak.fill(0); trk.seen.fill(0); trk.want.fill(false);
  hideAll(view.seg);
}
function stopCamera() { if (video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; } state.camOn = false; view.setSource(null); }

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
const isShownSeg = (s) => state.mode === '3d' || segShown(s);
function updateLabels(box, show, inMask) {
  const host = $('labels'), W = stage.clientWidth, H = stage.clientHeight;
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const cands = [];
  let best = null, bestScore = -Infinity;
  if (show && state.model) {
    for (const p of state.model.parts) {
      const g = GROUP(p.kind);
      if (!view.visible[g] || PRIORITY[g] === undefined || !isShownSeg(p.seg)) continue;
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
    const sx = state.mirror && state.mode === 'cam' ? W / 2 - c.q.x : W / 2 + c.q.x, sy = H / 2 - c.q.y;
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
    // The caption only changes once a new answer has held for a moment (no flicker between two bones).
    const txt = best ? `${regionOf(best)} · ${shortName(best.name)}` : '', C = state.caption;
    if (txt !== C.cand) { C.cand = txt; C.since = now(); }
    if (C.text !== txt && (now() - C.since > 450 || !C.text)) C.text = txt;
    if ($('regionText').textContent !== C.text) $('regionText').textContent = C.text;
  }
}

/** Brightness of the room from the camera picture, so the inside is lit like the outside. */
function sceneExposure() {
  if (!small.width) return 1;
  const d = smallCtx.getImageData(0, 0, small.width, small.height).data;
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 17) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
  const y = n ? sum / n / 255 : 0.45;
  return clamp(0.62 + y * 0.9, 0.7, 1.25);
}
/** Direction of the limb in the middle of the window (muscle fibres run along it). */
function fiberDir(box) {
  const J = state.model.pose, cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  let best = null, bd = Infinity;
  for (const [s, a, b] of [[SEG.forearm[0], 13, 15], [SEG.forearm[1], 14, 16], [SEG.upperArm[0], 11, 13], [SEG.upperArm[1], 12, 14], [SEG.thigh[0], 23, 25], [SEG.thigh[1], 24, 26], [SEG.shin[0], 25, 27], [SEG.shin[1], 26, 28], [SEG.hand[0], 15, 19], [SEG.hand[1], 16, 20]]) {
    const M = view.seg[s]; if (!segShown(s)) continue;
    const A = J[a].clone().applyMatrix4(M), B = J[b].clone().applyMatrix4(M), mid = A.clone().add(B).multiplyScalar(0.5);
    const d = Math.hypot(mid.x - cx, mid.y - cy), v = new THREE.Vector2(B.x - A.x, B.y - A.y);
    if (v.lengthSq() > 4 && d < bd) { bd = d; best = v.normalize(); }
  }
  return best || new THREE.Vector2(0, 1);
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
  if (!state.locked) return 'Point at a hand, or step back so your shoulders are in view';
  if (now() - state.lastGood > 1500) return 'Lost it. Step back a little';
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
          else commit(BODY_SEGS);
        } else {
          const hands = await state.hands.detect(src);
          const img = hands.length ? smallCtx.getImageData(0, 0, sm.width, sm.height).data : null;
          found = onHands(hands, src, W, H, img, sm.width, sm.height) || found;
        }
        // Optical flow keeps the lock when nothing is detected (camera close to the skin).
        if (state.locked) {
          const map = coverMap(W, H, src.videoWidth || src.width, src.videoHeight || src.height), b = windowBox();
          const p0 = map.toPic(b.x0, b.y1), p1 = map.toPic(b.x1, b.y0);
          const m = state.flow.update(src, { cx: (p0[0] + p1[0]) / 2, cy: (p0[1] + p1[1]) / 2, rx: Math.abs(p1[0] - p0[0]) / 2, ry: Math.abs(p1[1] - p0[1]) / 2 }, state.skin);
          const lastDet = Math.max(state.lastPose, state.lastHand.left, state.lastHand.right), stale = now() - lastDet > 300;
          // follow the picture for up to 2 s; after that, let it fade rather than drift
          if (m && stale && !found && now() - lastDet < 2000) { onFlow(m, src, W, H); state.lastGood = now(); }
        }
        if (!stepSegments(now()) && now() - state.lastGood > 600) state.locked = false;
      }
      const live = state.locked && trk.a.some((a) => a > 0.05);
      state.fade += ((live && state.xray ? 1 : 0) - state.fade) * 0.12;
      state.on += ((state.xray ? 1 : 0) - state.on) * 0.2;
      renderer.clear();
      const box = windowBox();
      if (state.on > 0.01) {
        const outline = state.outline && now() - state.lastGood < 2500 ? state.outline : null;
        if (state.fade > 0.01) view.paintMask(W, H, box, openingShapes(W, H), outline);
        let inMask = null;
        if (state.fade > 0.01) {
          const mc = view.maskCanvas, sc = mc.width / W, md = mc.getContext('2d').getImageData(0, 0, mc.width, mc.height).data;
          inMask = (q) => { const x = Math.round((W / 2 + q.x) * sc), y = Math.round((H / 2 - q.y) * sc); return x >= 0 && y >= 0 && x < mc.width && y < mc.height && md[(y * mc.width + x) * 4] > 140; };
        }
        const map = coverMap(W, H, src.videoWidth || src.width, src.videoHeight || src.height);
        if (state.frame % 15 === 0 || !state.exposure) state.exposure = sceneExposure();
        if (state.fade > 0.01) view.render(W, H, box, { mask: true, fade: state.fade, cam: map, exposure: state.exposure, fiber: fiberDir(box) });
        if (state.fade > 0.01) updateLabels(box, true, inMask); else { updateLabels(box, false); $('regionText').textContent = ''; state.caption.text = ''; }
      } else { updateLabels(box, false); $('regionText').textContent = ''; }
      $('lock').style.display = state.xray && live && now() - state.lastGood < 1500 ? 'block' : 'none';
    } else if (state.mode === '3d' && state.model) {
      renderer.clear();
      pose3d(W, H);
      view.render(W, H, { x0: -W / 2, x1: W / 2, y0: -H / 2, y1: H / 2 }, { mask: false, fade: 1, cavity: false, exposure: 1.05 });
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
  view.seg.forEach((m) => m.copy(M)); view.segA.fill(1);
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
  applyLayers(); syncButtons(); resize(); applyMirror();
  if (mode === 'cam') { resetTracking(); startCamera(); ensureTrackers(); } else stopCamera();
}
function syncButtons() {
  $('xrayBtn').classList.toggle('on', state.xray);
  $('xrayBtn').textContent = state.xray ? 'X-RAY ON' : 'X-RAY';
  $('layerBtn').textContent = LAYERS[state.layer].label;
  $('flipBtn').style.display = state.mode === 'cam' ? '' : 'none';
  $('labelBtn').classList.toggle('on', state.labels);
  $('box').style.display = state.mode === 'cam' && state.xray ? 'block' : 'none';
  for (const b of $('chips').children) b.classList.toggle('on', !!chips3d[b.dataset.kind]);
}
for (const b of document.querySelectorAll('#modes button')) b.onclick = () => setMode(b.dataset.mode);
$('xrayBtn').onclick = () => { state.xray = !state.xray; state.xrayAt = now(); if (!state.xray) resetTracking(); syncButtons(); };
$('flipBtn').onclick = async () => {
  if (state.testSource) { state.mirror = !state.mirror; applyMirror(); return; }
  state.facing = state.facing === 'user' ? 'environment' : 'user';
  resetTracking(); stopCamera(); await startCamera();
};
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
  useTestSource(el) { el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none'; stage.insertBefore(el, c3d); state.testSource = el; state.camOn = false; state.camError = ''; resetTracking(); if (state.mode === 'cam') { video.style.display = 'none'; el.style.display = 'block'; startCamera(); } },
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
