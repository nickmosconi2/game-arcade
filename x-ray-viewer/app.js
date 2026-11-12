// X-Ray Mirror: the phone camera tracks your face and hands, and a real 3D anatomy dataset (skull,
// brain, eyes, vessels, hand bones; BodyParts3D) is pinned to them, drawn like an X-ray.
import * as THREE from './vendor/three.module.min.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), video = $('video'), glCanvas = $('gl'), overlay = $('overlay'), octx = overlay.getContext('2d');
const now = () => performance.now();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- settings (remembered on this phone) ----------
const DEFAULTS = {
  layers: { skull: true, brain: true, muscles: false, eyes: true, vessels: false, outline: true, hands: true },
  labels: true, look: 'xray', bright: 1, through: 0.45, feather: 0.35, mode: 'whole', lens: 1.1, track: false,
  fit: { size: 1, w: 1, h: 1, d: 1, x: 0, y: 0, z: 0 }, facing: 'user',
};
let S = structuredClone(DEFAULTS);
try { const s = JSON.parse(localStorage.getItem('xraymirror') || 'null'); if (s) S = { ...S, ...s, layers: { ...S.layers, ...s.layers }, fit: { ...S.fit, ...s.fit } }; } catch {}
const save = () => { try { localStorage.setItem('xraymirror', JSON.stringify(S)); } catch {} };

// ---------- small maths ----------
function bestRotation(src, dst) {
  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
  for (let i = 0; i < src.length; i++) {
    const a = src[i], b = dst[i];
    Sxx += a.x * b.x; Sxy += a.x * b.y; Sxz += a.x * b.z; Syx += a.y * b.x; Syy += a.y * b.y; Syz += a.y * b.z; Szx += a.z * b.x; Szy += a.z * b.y; Szz += a.z * b.z;
  }
  const N = [[Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx], [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy], [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz]];
  let shift = 0; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) shift += Math.abs(N[i][j]);
  let q = [1, 0, 0, 0];
  for (let it = 0; it < 50; it++) {
    const r = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) r[i] += (N[i][j] + (i === j ? shift : 0)) * q[j];
    const l = Math.hypot(...r) || 1; q = r.map((v) => v / l);
  }
  return new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(q[1], q[2], q[3], q[0]));
}
/** Rotation + uniform scale + translation taking src points onto dst points. */
function fitSimilarity(src, dst) {
  const cs = new THREE.Vector3(), cd = new THREE.Vector3();
  src.forEach((v) => cs.add(v)); cs.divideScalar(src.length); dst.forEach((v) => cd.add(v)); cd.divideScalar(dst.length);
  const s0 = src.map((v) => v.clone().sub(cs)), d0 = dst.map((v) => v.clone().sub(cd));
  const rot = bestRotation(s0, d0);
  let np = 0, nd = 0;
  for (let i = 0; i < s0.length; i++) { const w = s0[i].clone().applyMatrix4(rot); np += w.x * w.x + w.y * w.y; nd += d0[i].x * d0[i].x + d0[i].y * d0[i].y; }
  const scale = Math.sqrt(nd / Math.max(np, 1e-9));
  const M = new THREE.Matrix4().makeTranslation(cd.x, cd.y, cd.z).multiply(rot).multiply(new THREE.Matrix4().makeScale(scale, scale, scale)).multiply(new THREE.Matrix4().makeTranslation(-cs.x, -cs.y, -cs.z));
  return { M, rot, scale };
}
function frame(dir, ref) {
  const x = dir.clone().normalize(), z = ref.clone().addScaledVector(x, -ref.dot(x));
  if (z.lengthSq() < 1e-8) z.set(0, 0, 1).addScaledVector(x, -x.z);
  z.normalize();
  return new THREE.Matrix4().makeBasis(x, new THREE.Vector3().crossVectors(z, x), z);
}
/** Lay a bone (restA->restB) from A to B: exact length, thickness from `scale`. */
function laySegment(restA, restB, A, B, baseRot, ref, scale) {
  const rv = restB.clone().sub(restA), rl = rv.length(), ud = B.clone().sub(A), ul = ud.length();
  if (ul < 1e-3 || rl < 1e-3) return null;
  const kLen = Math.min(2.5 * scale, ul / rl), kTh = scale * clamp(kLen / scale, 0.8, 1.25), d = rv.clone().divideScalar(rl), e = kLen - kTh;
  const Sm = new THREE.Matrix4().set(kTh + e * d.x * d.x, e * d.x * d.y, e * d.x * d.z, 0, e * d.y * d.x, kTh + e * d.y * d.y, e * d.y * d.z, 0, e * d.z * d.x, e * d.z * d.y, kTh + e * d.z * d.z, 0, 0, 0, 0, 1);
  const Q = frame(ud, ref).multiply(frame(rv.clone().transformDirection(baseRot), ref).transpose());
  return new THREE.Matrix4().makeTranslation(A.x, A.y, A.z).multiply(Q).multiply(baseRot).multiply(Sm).multiply(new THREE.Matrix4().makeTranslation(-restA.x, -restA.y, -restA.z));
}
/** One-euro filter over a list of points: steady when still, quick when moving. */
class Smoother {
  constructor(minCut = 1.6, beta = 0.015) { this.minCut = minCut; this.beta = beta; this.x = null; this.t = 0; }
  filter(P, t) {
    if (!this.x || this.x.length !== P.length || t - this.t > 0.4) { this.x = P.map((p) => p.clone()); this.dx = P.map(() => new THREE.Vector3()); this.t = t; return this.x.map((p) => p.clone()); }
    const dt = Math.max(1 / 120, t - this.t); this.t = t;
    const a = (cut) => 1 / (1 + 1 / (2 * Math.PI * cut * dt)), ad = a(1);
    for (let i = 0; i < P.length; i++) {
      this.dx[i].lerp(P[i].clone().sub(this.x[i]).divideScalar(dt), ad);
      this.x[i].lerp(P[i], a(this.minCut + this.beta * this.dx[i].length()));
    }
    return this.x.map((p) => p.clone());
  }
}

// ---------- rendering ----------
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -8000, 8000);
const shared = {
  uLook: { value: 0 }, uBright: { value: 1 }, uMode: { value: 0 }, uFeather: { value: 0.35 }, uLensC: { value: new THREE.Vector2() }, uLensR: { value: 200 },
  uThrough: { value: 0.45 },
};
const VERT_HEAD = `
uniform mat4 uM;
out vec3 vN; out vec3 vP; out vec3 vH;
void main() { vH = position; vec4 p = uM * vec4(position, 1.0); vP = p.xyz; vN = normalize(mat3(uM) * normal); gl_Position = projectionMatrix * viewMatrix * p; }`;
const VERT_HAND = `
uniform mat4 uSeg[16];
in float seg;
out vec3 vN; out vec3 vP; out vec3 vH;
void main() { mat4 M = uSeg[int(seg + 0.5)]; vH = vec3(0.0); vec4 p = M * vec4(position, 1.0); vP = p.xyz; vN = normalize(mat3(M) * normal); gl_Position = projectionMatrix * viewMatrix * p; }`;
const CLIP = `
uniform float uMode, uFeather, uClipHead, uAlpha;
uniform vec2 uLensC; uniform float uLensR;
float clipA() {
  float a = uAlpha, f = max(uFeather, 0.02);
  if (uClipHead > 0.5 && uMode > 0.5 && uMode < 1.5) a *= smoothstep(-0.2 - f * 2.5, 0.2 + f * 2.5, -vH.x);   // right half (cm, head space)
  if (uClipHead > 0.5 && uMode > 1.5) { float d = length(vP.xy - uLensC) / uLensR; a *= 1.0 - smoothstep(1.0 - f * 0.6, 1.0, d); }
  return a;
}`;
const FRAG = `
precision highp float;
in vec3 vN; in vec3 vP; in vec3 vH;
uniform vec3 uColor, uSolid;
uniform float uBase, uEdge, uPow, uLook, uBright, uSolidOnly;
out vec4 outColor;
${CLIP}
void main() {
  float a = clipA();
  if (a < 0.003) discard;
  vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
  if (uLook < 0.5 || uSolidOnly < -0.5) {
    // X-ray: each surface adds light, brightest where you look along it (edges), like a radiograph
    float edge = pow(1.0 - abs(n.z), uPow);
    float v = (uBase + uEdge * edge) * uBright;
    outColor = vec4(uColor * v * a, 1.0);
  } else {
    vec3 L = normalize(vec3(-0.35, 0.55, 0.76));
    float dif = max(dot(n, L), 0.0), spec = pow(max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 40.0);
    vec3 c = uSolid * (0.32 + 0.75 * dif) * uBright + spec * 0.25 + pow(1.0 - abs(n.z), 3.0) * 0.12;
    outColor = vec4(c * a, a);
  }
}`;
const FRAG_BACK = `
precision highp float;
in vec3 vN; in vec3 vP; in vec3 vH;
uniform float uThrough;
out vec4 outColor;
${CLIP}
void main() { float a = clipA() * (1.0 - uThrough) * 0.92; if (a < 0.003) discard; outColor = vec4(vec3(0.015, 0.025, 0.045) * a, a); }`;

const STYLE = {
  skull:   { color: [0.80, 0.90, 1.00], solid: [0.92, 0.88, 0.78], base: 0.035, edge: 0.48, pow: 1.7 },
  jaw:     { color: [0.80, 0.90, 1.00], solid: [0.92, 0.88, 0.78], base: 0.035, edge: 0.48, pow: 1.7 },
  brain:   { color: [1.00, 0.45, 0.66], solid: [0.88, 0.62, 0.66], base: 0.012, edge: 0.2, pow: 1.4 },
  eyes:    { color: [1.00, 0.95, 0.80], solid: [0.95, 0.95, 0.92], base: 0.015, edge: 0.18, pow: 1.6 },
  muscles: { color: [1.00, 0.42, 0.38], solid: [0.72, 0.22, 0.20], base: 0.03, edge: 0.30, pow: 1.4 },
  vessels: { color: [1.00, 0.30, 0.40], solid: [0.80, 0.12, 0.16], base: 0.10, edge: 0.35, pow: 1.2 },
  outline: { color: [0.22, 0.48, 1.00], solid: [0.22, 0.48, 1.00], base: 0.0, edge: 1.5, pow: 2.6, xrayOnly: true },
  hands:   { color: [0.80, 0.90, 1.00], solid: [0.92, 0.88, 0.78], base: 0.05, edge: 0.6, pow: 1.6 },
};
const head = { meshes: {}, M: new THREE.Matrix4(), Mjaw: new THREE.Matrix4(), info: null, canon: null, alpha: 0, seen: -1e9, scale: 1 };
const hands = { left: null, right: null, info: null };

function makeMaterial(group, vert, extra = {}) {
  const st = STYLE[group];
  const u = {
    ...shared, uM: { value: new THREE.Matrix4() }, uAlpha: { value: 0 }, uClipHead: { value: group === 'hands' ? 0 : 1 },
    uColor: { value: new THREE.Vector3(...st.color) }, uSolid: { value: new THREE.Vector3(...st.solid) },
    uBase: { value: st.base }, uEdge: { value: st.edge }, uPow: { value: st.pow }, uSolidOnly: { value: st.xrayOnly ? -1 : 0 }, ...extra,
  };
  const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: u, vertexShader: vert, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  additive(m); return m;
}
// Glow adds light over the camera picture without touching the page's transparency (alpha stays 0,
// so the browser composites it as pure added light).
function additive(mat) {
  mat.blending = THREE.CustomBlending; mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneFactor; mat.blendSrcAlpha = THREE.ZeroFactor; mat.blendDstAlpha = THREE.OneFactor;
}
function setLook(mat, group) {
  const add = S.look === 'xray' || STYLE[group].xrayOnly;
  if ((mat.blending === THREE.CustomBlending) === add) return;
  if (add) additive(mat); else { mat.blending = THREE.NormalBlending; mat.premultipliedAlpha = true; }
  mat.depthTest = !add; mat.depthWrite = !add; mat.needsUpdate = true;
}

async function loadModels(onProgress) {
  const [hi, hb, ni, nb] = await Promise.all([
    fetch('models/head.json').then((r) => r.json()), fetchBin('models/head.bin', onProgress, 3004204),
    fetch('models/hands.json').then((r) => r.json()), fetch('models/hands.bin').then((r) => r.arrayBuffer()),
  ]);
  head.info = hi; head.canon = hi.canon.map((p) => new THREE.Vector3(...p));
  // stable face points for the fit: above the mouth (the jaw and lips move on their own)
  head.fitIdx = head.canon.map((p, i) => [p, i]).filter(([p]) => p.y > -1.2).map(([, i]) => i);
  for (const [name, g] of Object.entries(hi.groups)) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(hb, g.pos[0], g.verts * 3), 3));
    const n8 = new Int8Array(hb, g.nrm[0], g.verts * 4), n = new Float32Array(g.verts * 3);
    for (let i = 0; i < g.verts; i++) { n[i * 3] = n8[i * 4] / 127; n[i * 3 + 1] = n8[i * 4 + 1] / 127; n[i * 3 + 2] = n8[i * 4 + 2] / 127; }
    geo.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(hb, g.idx[0], g.tris * 3), 1));
    const mesh = new THREE.Mesh(geo, makeMaterial(name, VERT_HEAD));
    mesh.frustumCulled = false; mesh.renderOrder = name === 'outline' ? 9 : 2;
    if (name === 'outline') mesh.material.side = THREE.FrontSide;
    scene.add(mesh); head.meshes[name] = mesh;
    if (name === 'outline') {
      const back = new THREE.Mesh(geo, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: { ...shared, uM: mesh.material.uniforms.uM, uAlpha: mesh.material.uniforms.uAlpha, uClipHead: { value: 1 } }, vertexShader: VERT_HEAD, fragmentShader: FRAG_BACK, transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false, side: THREE.FrontSide }));
      back.frustumCulled = false; back.renderOrder = 0; scene.add(back); head.backdrop = back;
    }
  }
  hands.info = ni;
  for (const side of ['left', 'right']) {
    const g = ni.sides[side], geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nb, g.pos[0], g.verts * 3), 3));
    const n8 = new Int8Array(nb, g.nrm[0], g.verts * 4), n = new Float32Array(g.verts * 3);
    for (let i = 0; i < g.verts; i++) { n[i * 3] = n8[i * 4] / 127; n[i * 3 + 1] = n8[i * 4 + 1] / 127; n[i * 3 + 2] = n8[i * 4 + 2] / 127; }
    geo.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    const s8 = new Uint8Array(nb, g.seg[0], g.verts), sf = new Float32Array(g.verts); for (let i = 0; i < g.verts; i++) sf[i] = s8[i];
    geo.setAttribute('seg', new THREE.BufferAttribute(sf, 1));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(nb, g.idx[0], g.tris * 3), 1));
    const segs = Array.from({ length: 16 }, () => new THREE.Matrix4());
    const mesh = new THREE.Mesh(geo, makeMaterial('hands', VERT_HAND, { uSeg: { value: segs } }));
    mesh.frustumCulled = false; mesh.renderOrder = 3; scene.add(mesh);
    hands[side] = { mesh, segs, R: g.joints.map((p) => new THREE.Vector3(...p)), labels: g.labels, alpha: 0, seen: -1e9, P: null };
  }
}
async function fetchBin(url, onProgress, expected = 0) {
  // GitHub Pages sends files gzip-compressed, so Content-Length is the compressed size: collect the
  // chunks as they come instead of trusting it.
  const res = await fetch(url); if (!res.ok) throw new Error(`${url}: ${res.status}`);
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader(), parts = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; if (expected) onProgress(Math.min(1, got / expected)); }
  const out = new Uint8Array(got); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

// ---------- camera ----------
const state = { source: null, testSource: null, camOn: false, camError: '', mirror: false, face: null, hands: null, ready: false, frame: 0, lastFace: 0 };
function coverMap(W, H, sw, sh) {
  const k = Math.max(W / sw, H / sh), dw = sw * k, dh = sh * k, ox = (W - dw) / 2, oy = (H - dh) / 2;
  return { k, ox, oy, dw, dh, toScreen: (u, v) => [ox + u * dw - W / 2, H / 2 - (oy + v * dh)] };
}
async function startCamera() {
  if (state.testSource) { state.source = state.testSource; state.camOn = true; applyMirror(); return; }
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(window.isSecureContext ? 'no camera access in this browser' : 'the page must be opened over https');
    if (video.srcObject) video.srcObject.getTracks().forEach((t) => t.stop());
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: S.facing }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    video.srcObject = stream; await video.play();
    const set = stream.getVideoTracks()[0]?.getSettings?.() || {};
    state.mirror = (set.facingMode || S.facing) === 'user';
    state.source = video; state.camOn = true; state.camError = '';
  } catch (e) { state.camError = e.name === 'NotAllowedError' ? 'Camera access was refused. Allow the camera for this site, then reload.' : `Camera unavailable: ${e.message}`; }
  applyMirror();
}
function applyMirror() { stage.classList.toggle('mirror', state.mirror); }

// ---------- trackers (MediaPipe Tasks, bundled) ----------
const LIB = new URL('./vendor/mediapipe', import.meta.url).href;
async function startTrackers() {
  const v = await import('./vendor/mediapipe/vision_bundle.mjs');
  const files = await v.FilesetResolver.forVisionTasks(`${LIB}/wasm`);
  const make = async (fn) => { try { return await fn('GPU'); } catch { return fn('CPU'); } };
  [state.face, state.hands] = await Promise.all([
    make((delegate) => v.FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: `${LIB}/face_landmarker.task`, delegate }, runningMode: 'VIDEO', numFaces: 1, minFaceDetectionConfidence: 0.5, minTrackingConfidence: 0.5 })),
    make((delegate) => v.HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: `${LIB}/hand_landmarker.task`, delegate }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.5, minTrackingConfidence: 0.5 })),
  ]);
  state.ready = true;
}
let stamp = 0;
const nextStamp = () => (stamp = Math.max(stamp + 1, now()));

// ---------- head ----------
const faceSmooth = new Smoother(1.8, 0.02);
function onFace(lm, W, H, map) {
  const t = now();
  const P = lm.map((p) => { const q = map.toScreen(p.x, p.y); return new THREE.Vector3(q[0], q[1], -p.z * map.dw); });
  const Ps = faceSmooth.filter(P, t / 1000);
  const idx = head.fitIdx;
  const { M, scale } = fitSimilarity(idx.map((i) => head.canon[i]), idx.map((i) => Ps[i]));
  head.scale = scale; head.P = Ps;
  const f = S.fit;
  head.M.copy(M).multiply(new THREE.Matrix4().makeTranslation(f.x, f.y, f.z)).multiply(new THREE.Matrix4().makeScale(f.size * f.w, f.size * f.h, f.size * f.d));
  // the jaw opens with the mouth (inner lips 13 and 14)
  const gap = Ps[13].distanceTo(Ps[14]) / scale;
  const ang = clamp(Math.atan2(Math.max(0, gap - 0.15), 9.5) * 1.15, 0, 0.5);
  const pv = new THREE.Vector3(...head.info.jawPivot);
  head.Mjaw.copy(head.M).multiply(new THREE.Matrix4().makeTranslation(pv.x, pv.y, pv.z)).multiply(new THREE.Matrix4().makeRotationX(ang)).multiply(new THREE.Matrix4().makeTranslation(-pv.x, -pv.y, -pv.z));
  head.seen = t;
}

// ---------- hands ----------
const PALM = [0, 5, 9, 13, 17];
const FINGER_SEGS = [[0, 1, 2], [1, 2, 3], [2, 3, 4], [3, 5, 6], [4, 6, 7], [5, 7, 8], [6, 9, 10], [7, 10, 11], [8, 11, 12], [9, 13, 14], [10, 14, 15], [11, 15, 16], [12, 17, 18], [13, 18, 19], [14, 19, 20]];
const HAND_PAIRS = [[0, 5], [0, 17], [5, 17], [0, 9], [5, 9], [9, 13], [13, 17]];
const slots = [];
function handPoints(h, map) {
  const img = h.image.map((p) => map.toScreen(p.x, p.y));
  let num = 0, den = 0;
  for (const [a, b] of HAND_PAIRS) { num += Math.hypot(img[a][0] - img[b][0], img[a][1] - img[b][1]); den += Math.hypot(h.world[a].x - h.world[b].x, h.world[a].y - h.world[b].y); }
  const k = den > 1e-6 ? num / den : 1000, z0 = h.world[0].z;
  return img.map((p, i) => new THREE.Vector3(p[0], p[1], -(h.world[i].z - z0) * k));
}
function solveHand(hd, P) {
  const R = hd.R, { M: palm, scale } = fitSimilarity(PALM.map((j) => R[j]), PALM.map((j) => P[j]));
  hd.segs[0].copy(palm);
  const rot = new THREE.Matrix4().extractRotation(palm);
  const n = new THREE.Vector3().crossVectors(R[5].clone().sub(R[0]), R[17].clone().sub(R[0])).normalize().transformDirection(rot);
  const across = R[17].clone().sub(R[5]).transformDirection(rot);
  for (const [f, a, b] of FINGER_SEGS) {
    const u = P[b].clone().sub(P[a]).normalize();
    const M = laySegment(R[a], R[b], P[a], P[b], rot, Math.abs(u.dot(n)) < 0.8 ? n : across, scale);
    hd.segs[f + 1].copy(M || palm);
  }
}
function onHands(list, map) {
  const t = now();
  let items = list.filter((h) => h.score > 0.6).map((h) => ({ h, P: handPoints(h, map) }));
  items.sort((a, b) => b.h.score - a.h.score);
  items = items.filter((x, i) => !items.slice(0, i).some((y) => x.P[0].distanceTo(y.P[0]) < 0.6 * y.P[0].distanceTo(y.P[9])));
  for (const sl of slots) sl.used = false;
  for (const x of items) {
    const hl = x.P[0].distanceTo(x.P[9]);
    let best = null, bd = 2.5 * hl;
    for (const sl of slots) if (!sl.used && t - sl.last < 1500) { const d = sl.P[0].distanceTo(x.P[0]); if (d < bd) { bd = d; best = sl; } }
    if (!best) { best = { vote: 0, side: null, smooth: new Smoother(1.6, 0.015), last: 0, streak: 0 }; slots.push(best); }
    best.used = true; best.last = t; best.streak++;
    best.vote = best.vote * 0.75 + (x.h.label === 'Right' ? 0.25 : -0.25);
    const want = best.vote >= 0 ? 'right' : 'left';
    if (!best.side || (want !== best.side && Math.abs(best.vote) > 0.45)) best.side = want;
    best.P = best.smooth.filter(x.P, t / 1000);
  }
  for (let i = slots.length - 1; i >= 0; i--) if (t - slots[i].last > 1500) slots.splice(i, 1);
  const live = slots.filter((s) => s.used && s.streak >= 2);
  if (live.length === 2 && live[0].side === live[1].side) { const w = Math.abs(live[0].vote) < Math.abs(live[1].vote) ? live[0] : live[1]; w.side = w.side === 'left' ? 'right' : 'left'; }
  for (const sl of live) { const hd = hands[sl.side]; solveHand(hd, sl.P); hd.P = sl.P; hd.seen = t; }
}

// ---------- labels with leader lines ----------
const HEAD_LABELS = {
  skull: ['Frontal bone', 'Parietal bone', 'Temporal bone', 'Occipital bone', 'Nasal bone', 'Zygomatic bone (cheekbone)', 'Maxilla (upper jaw)', 'Teeth'],
  jaw: ['Mandible (lower jaw)'],
  brain: ['Frontal lobe', 'Parietal lobe', 'Temporal lobe', 'Occipital lobe', 'Cerebellum', 'Pons (brainstem)', 'Medulla oblongata'],
  eyes: ['Eyeball'], muscles: ['Eye muscles', 'Tongue'], vessels: ['Brain arteries'],
};
function headLabelPoints() {
  const out = [];
  const byText = {};
  for (const l of head.info.labels) {
    const grp = l.group === 'jaw' ? 'skull' : l.group;
    if (!S.layers[grp]) continue;
    const list = HEAD_LABELS[l.group]; if (!list || !list.includes(l.text)) continue;
    let at = new THREE.Vector3(...l.at);
    if (l.text === 'Mandible (lower jaw)') at = new THREE.Vector3(...head.info.jawTip).add(new THREE.Vector3(0, -1.6, 0));
    const q = at.applyMatrix4(l.group === 'jaw' ? head.Mjaw : head.M);
    if (!byText[l.text] || q.z > byText[l.text].q.z) byText[l.text] = { text: l.text, q };
  }
  for (const v of Object.values(byText)) out.push(v);
  return out;
}
function handLabelPoints(hd) {
  const want = { 'Distal phalanx': 6, 'Middle phalanx': 5, 'Proximal phalanx': 4, 'Metacarpal': 0, 'Carpal bones (wrist)': 0 };
  const out = [], done = new Set();
  for (const l of hd.labels) {
    if (done.has(l.text)) continue;
    if (l.text === 'Metacarpal' && !/second metacarpal/i.test(l.name)) continue;
    if (l.text === 'Carpal bones (wrist)' && !/capitate/i.test(l.name)) continue;
    if (/phalanx/.test(l.text) && !/index/i.test(l.name)) continue;
    done.add(l.text);
    out.push({ text: l.text, q: new THREE.Vector3(...l.at).applyMatrix4(hd.segs[l.seg]) });
  }
  void want;
  return out;
}
/** Labels in columns beside the subject, each joined to its point by a thin leader line. */
function drawColumn(W, H, list, side, x0, alpha) {
  octx.font = '600 11px -apple-system, system-ui, sans-serif'; octx.textBaseline = 'middle';
  list.sort((a, b) => a.y - b.y);
  const gap = 14, ly = list.map((p) => p.y);
  for (let i = 1; i < ly.length; i++) ly[i] = Math.max(ly[i], ly[i - 1] + gap);
  const over = ly.length ? ly[ly.length - 1] - (H - 120) : 0; if (over > 0) for (let i = 0; i < ly.length; i++) ly[i] -= over;
  for (let i = ly.length - 2; i >= 0; i--) ly[i] = Math.min(ly[i], ly[i + 1] - gap);
  list.forEach((p, i) => {
    const tw = octx.measureText(p.text).width;
    const tx = side < 0 ? clamp(x0, 6 + tw, W - 6) : clamp(x0, 6, W - 6 - tw);
    octx.strokeStyle = `rgba(255,255,255,${0.5 * alpha})`; octx.lineWidth = 0.8;
    octx.beginPath(); octx.moveTo(p.x, p.y); octx.lineTo(tx + (side < 0 ? 8 : -8), ly[i]); octx.lineTo(tx + (side < 0 ? 3 : -3), ly[i]); octx.stroke();
    octx.fillStyle = `rgba(255,255,255,${0.95 * alpha})`; octx.beginPath(); octx.arc(p.x, p.y, 1.7, 0, 7); octx.fill();
    octx.textAlign = side < 0 ? 'right' : 'left';
    octx.lineJoin = 'round'; octx.lineWidth = 3; octx.strokeStyle = `rgba(0,0,0,${0.55 * alpha})`; octx.strokeText(p.text, tx, ly[i]);
    octx.fillText(p.text, tx, ly[i]);
  });
}
const toVisual = (W, H, q) => ({ x: state.mirror ? W / 2 - q.x : W / 2 + q.x, y: H / 2 - q.y });

// ---------- main loop ----------
function resize() {
  const W = stage.clientWidth, H = stage.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr); renderer.setSize(W, H, false);
  overlay.width = Math.round(W * dpr); overlay.height = Math.round(H * dpr);
}
window.addEventListener('resize', resize);
function hintText() {
  if (state.camError) return state.camError;
  if (!state.camOn) return 'Starting camera…';
  if (!head.info) return 'Loading anatomy…';
  if (!state.ready) return 'Getting ready…';
  if (now() - head.seen > 1200 && now() - Math.max(hands.left?.seen || 0, hands.right?.seen || 0) > 1200) return 'Look at the camera';
  return '';
}
async function tick() {
  try {
    const W = stage.clientWidth, H = stage.clientHeight, t = now();
    const src = state.source;
    if (state.ready && head.info && src && (src !== video || video.readyState >= 2)) {
      const map = coverMap(W, H, src.videoWidth || src.width, src.videoHeight || src.height);
      state.frame++;
      if (state.frame % 2 === 0 || !S.layers.hands) {
        const r = state.face.detectForVideo(src, nextStamp());
        if (r.faceLandmarks && r.faceLandmarks[0]) onFace(r.faceLandmarks[0], W, H, map);
      } else {
        const r = state.hands.detectForVideo(src, nextStamp());
        onHands((r.landmarks || []).map((lm, i) => ({ image: lm, world: r.worldLandmarks[i], label: r.handednesses?.[i]?.[0]?.categoryName || '', score: r.handednesses?.[i]?.[0]?.score || 0 })), map);
      }
    }
    // fade in/out
    const fadeTo = (cur, on) => cur + ((on ? 1 : 0) - cur) * (on ? 0.25 : 0.15);
    head.alpha = fadeTo(head.alpha, t - head.seen < 300);
    for (const side of ['left', 'right']) if (hands[side]) hands[side].alpha = fadeTo(hands[side].alpha, S.layers.hands && t - hands[side].seen < 400);
    // uniforms
    shared.uLook.value = S.look === 'xray' ? 0 : 1; shared.uBright.value = S.bright; shared.uThrough.value = S.through;
    shared.uFeather.value = S.feather; shared.uMode.value = S.mode === 'half' ? 1 : S.mode === 'lens' ? 2 : 0;
    if (head.info) {
      const c = new THREE.Vector3(0, 1.0, 1.5).applyMatrix4(head.M);
      shared.uLensC.value.set(c.x, c.y); shared.uLensR.value = 9.5 * head.scale * S.fit.size * S.lens;
      for (const [name, m] of Object.entries(head.meshes)) {
        const on = name === 'jaw' ? S.layers.skull : S.layers[name];
        m.visible = on && head.alpha > 0.01; setLook(m.material, name);
        m.material.uniforms.uM.value.copy(name === 'jaw' ? head.Mjaw : head.M);
        m.material.uniforms.uAlpha.value = head.alpha;
      }
      head.backdrop.visible = head.alpha > 0.01 && S.through < 0.99;
      for (const side of ['left', 'right']) { const hd = hands[side]; hd.mesh.visible = hd.alpha > 0.01; setLook(hd.mesh.material, 'hands'); hd.mesh.material.uniforms.uAlpha.value = hd.alpha; }
    }
    camera.left = -W / 2; camera.right = W / 2; camera.top = H / 2; camera.bottom = -H / 2; camera.updateProjectionMatrix();
    renderer.clear(); renderer.render(scene, camera);
    // overlay: labels, lens ring, tracking data
    const dpr = overlay.width / W;
    octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, overlay.width, overlay.height); octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const vx = (x) => (state.mirror ? W / 2 - x : W / 2 + x), vy = (y) => H / 2 - y;
    if (head.info && head.alpha > 0.05) {
      if (S.mode === 'lens') { octx.strokeStyle = `rgba(255,255,255,${0.35 * head.alpha})`; octx.lineWidth = 1; octx.beginPath(); octx.arc(vx(shared.uLensC.value.x), vy(shared.uLensC.value.y), shared.uLensR.value, 0, 7); octx.stroke(); }
      if (S.labels) {
        let pts = headLabelPoints();
        if (S.mode === 'half') { const cx = new THREE.Vector3(0, 0, 0).applyMatrix4(head.M); const rx = new THREE.Vector3(-4, 0, 0).applyMatrix4(head.M); pts = pts.filter((p) => (p.q.x - cx.x) * (rx.x - cx.x) > -2); }
        const c = toVisual(W, H, new THREE.Vector3(0, 2, 0).applyMatrix4(head.M)), spread = 10.5 * head.scale * S.fit.size;
        const L = [], R = [];
        for (const p of pts) { const v = toVisual(W, H, p.q); (v.x < c.x ? L : R).push({ text: p.text, ...v }); }
        drawColumn(W, H, L, -1, c.x - spread, head.alpha); drawColumn(W, H, R, 1, c.x + spread, head.alpha);
      }
    }
    for (const side of ['left', 'right']) {
      const hd = hands[side];
      if (!hd || hd.alpha < 0.05 || !S.labels) continue;
      // labels in a column on the side of the hand away from the face (or the screen edge it is nearer)
      const pts = handLabelPoints(hd).map((p) => ({ text: p.text, ...toVisual(W, H, p.q) }));
      const xs = hd.P.map((p) => toVisual(W, H, p).x), minX = Math.min(...xs), maxX = Math.max(...xs);
      const faceX = head.alpha > 0.1 ? toVisual(W, H, new THREE.Vector3(0, 0, 0).applyMatrix4(head.M)).x : W / 2;
      const sideV = (minX + maxX) / 2 < faceX ? -1 : 1;
      drawColumn(W, H, pts, sideV, sideV < 0 ? minX - 14 : maxX + 14, hd.alpha);
    }
    if (S.track) {
      octx.fillStyle = 'rgba(80,220,255,.8)';
      if (head.P && t - head.seen < 300) for (const p of head.P) { octx.fillRect(vx(p.x) - 0.7, vy(p.y) - 0.7, 1.4, 1.4); }
      octx.fillStyle = 'rgba(120,255,160,.9)';
      for (const side of ['left', 'right']) { const hd = hands[side]; if (hd?.P && t - hd.seen < 300) for (const p of hd.P) { octx.beginPath(); octx.arc(vx(p.x), vy(p.y), 2, 0, 7); octx.fill(); } }
    }
    const h = hintText();
    if ($('hintText').textContent !== h) $('hintText').textContent = h;
    $('hint').classList.toggle('off', !h);
  } catch (e) { console.error(e); }
  requestAnimationFrame(tick);
}

// ---------- panel ----------
function syncUI() {
  for (const ck of document.querySelectorAll('[data-layer]')) ck.checked = !!S.layers[ck.dataset.layer];
  $('labelsCk').checked = S.labels; $('labelsBtn').classList.toggle('on', S.labels);
  for (const b of document.querySelectorAll('#looks button')) b.classList.toggle('on', b.dataset.look === S.look);
  $('lookBtn').textContent = S.look === 'xray' ? 'Solid' : 'X-ray';
  $('bright').value = S.bright; $('through').value = S.through; $('feather').value = S.feather; $('mode').value = S.mode; $('lens').value = S.lens; $('trackCk').checked = S.track;
  for (const [k, id] of [['size', 'size'], ['w', 'w'], ['h', 'h'], ['d', 'd'], ['x', 'x'], ['y', 'y'], ['z', 'z']]) {
    $(`f_${id}`).value = S.fit[k];
    $(`v_${id}`).textContent = ['x', 'y', 'z'].includes(k) ? `${S.fit[k].toFixed(1)} cm` : `${Math.round(S.fit[k] * 100)}%`;
  }
}
for (const ck of document.querySelectorAll('[data-layer]')) ck.onchange = () => { S.layers[ck.dataset.layer] = ck.checked; save(); syncUI(); };
$('labelsCk').onchange = () => { S.labels = $('labelsCk').checked; save(); syncUI(); };
$('labelsBtn').onclick = () => { S.labels = !S.labels; save(); syncUI(); };
const PRESETS = {
  skull: { skull: true, brain: false, muscles: false, eyes: true, vessels: false, outline: true },
  brain: { skull: false, brain: true, muscles: false, eyes: false, vessels: true, outline: true },
  muscles: { skull: true, brain: false, muscles: true, eyes: true, vessels: false, outline: true },
  all: { skull: true, brain: true, muscles: true, eyes: true, vessels: true, outline: true },
};
for (const b of document.querySelectorAll('#presets button')) b.onclick = () => { Object.assign(S.layers, PRESETS[b.dataset.p]); save(); syncUI(); };
for (const b of document.querySelectorAll('#looks button')) b.onclick = () => { S.look = b.dataset.look; save(); syncUI(); };
$('lookBtn').onclick = () => { S.look = S.look === 'xray' ? 'solid' : 'xray'; save(); syncUI(); };
for (const id of ['bright', 'through', 'feather', 'lens']) $(id).oninput = () => { S[id] = +$(id).value; save(); };
$('mode').onchange = () => { S.mode = $('mode').value; save(); };
$('trackCk').onchange = () => { S.track = $('trackCk').checked; save(); };
for (const k of ['size', 'w', 'h', 'd', 'x', 'y', 'z']) $(`f_${k}`).oninput = () => { S.fit[k] = +$(`f_${k}`).value; save(); syncUI(); };
$('resetFit').onclick = (e) => { e.preventDefault(); S.fit = { ...DEFAULTS.fit }; save(); syncUI(); };
$('panelBtn').onclick = () => $('panel').classList.toggle('open');
$('stage').addEventListener('click', () => $('panel').classList.remove('open'));
$('flipBtn').onclick = async () => {
  if (state.testSource) { state.mirror = !state.mirror; applyMirror(); return; }
  S.facing = S.facing === 'user' ? 'environment' : 'user'; save(); await startCamera();
};

window.__xm = {
  S, head, hands, state, slots,
  useTestSource(el, mirror = true) { el.className = 'test'; el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover'; stage.insertBefore(el, glCanvas); video.style.display = 'none'; if (video.srcObject) video.srcObject.getTracks().forEach((t) => t.stop()); state.testSource = el; state.source = el; state.camOn = true; state.camError = ''; state.mirror = mirror; applyMirror(); },
};

resize(); syncUI();
startCamera();
(async () => {
  try {
    await loadModels((f) => { $('busyText').textContent = `Loading anatomy… ${Math.round(f * 100)}%`; });
    $('busy').classList.add('hidden');
    await startTrackers();
  } catch (e) { console.error(e); $('busyText').textContent = `Could not start: ${e.message}`; }
})();
tick();
