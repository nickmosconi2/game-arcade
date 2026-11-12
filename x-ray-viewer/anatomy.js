// Anatomical arm model (BodyParts3D 4.0, CC BY 4.0) and its renderer.
// Every vertex is bound to one or two "segments" (forearm, palm, and each finger bone), so the
// model can be posed bone by bone from the user's tracked hand.
import * as THREE from './vendor/three.module.min.js';

export const SEG_COUNT = 44;
export const KIND_STYLE = {
  bone:         { color: [0.90, 0.85, 0.74], alpha: 1.0, order: 2, peel: 0 },
  artery:       { color: [0.86, 0.10, 0.12], alpha: 1.0, order: 3, peel: 0 },
  vein:         { color: [0.20, 0.32, 0.86], alpha: 1.0, order: 3, peel: 0 },
  nerve:        { color: [0.96, 0.85, 0.35], alpha: 1.0, order: 3, peel: 0 },
  organ_heart:  { color: [0.62, 0.10, 0.12], alpha: 1.0, order: 3, peel: 0 },
  organ_lung:   { color: [0.93, 0.62, 0.64], alpha: 0.82, order: 4, peel: 0.55 },
  organ_airway: { color: [0.90, 0.78, 0.74], alpha: 1.0, order: 3, peel: 0 },
  organ_liver:  { color: [0.48, 0.16, 0.12], alpha: 1.0, order: 3, peel: 0 },
  organ_gut:    { color: [0.90, 0.60, 0.55], alpha: 1.0, order: 3, peel: 0 },
  organ_kidney: { color: [0.55, 0.18, 0.15], alpha: 1.0, order: 3, peel: 0 },
  organ_gland:  { color: [0.85, 0.62, 0.30], alpha: 1.0, order: 3, peel: 0 },
  organ_eye:    { color: [0.95, 0.95, 0.93], alpha: 1.0, order: 3, peel: 0 },
  organ_other:  { color: [0.85, 0.55, 0.55], alpha: 1.0, order: 3, peel: 0 },
  muscle:       { color: [0.74, 0.20, 0.17], alpha: 0.88, order: 5, peel: 0.18 },
  tissue:       { color: [0.90, 0.85, 0.80], alpha: 0.5, order: 4, peel: 0.3 },
};
/** Display group for each tissue kind (layers, labels). */
export const GROUP = (k) => (k.startsWith('organ') ? 'organ' : k);

/** Load the whole-body model: geometry per tissue kind plus the rest-pose joints. */
export async function loadBody(base = 'models', onProgress) {
  const info = await fetch(`${base}/body.json`).then((r) => { if (!r.ok) throw new Error(`model not found (${r.status})`); return r.json(); });
  const res = await fetch(`${base}/body.bin`);
  if (!res.ok) throw new Error(`model not found (${res.status})`);
  let buf;
  const total = info.layout.idx[0] + info.layout.idx[1];
  if (res.body && onProgress) {
    const reader = res.body.getReader(), out = new Uint8Array(total); let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; out.set(value, got); got += value.length; onProgress(got / total); }
    buf = out.buffer;
  } else buf = await res.arrayBuffer();
  const L = info.layout, nv = info.verts;
  const pos = new Float32Array(buf, L.pos[0], nv * 3);
  const nrm = new Int8Array(buf, L.nrm[0], nv * 4);
  const skin = new Uint8Array(buf, L.skin[0], nv * 4);
  const idx = new Uint16Array(buf, L.idx[0], info.tris * 3);
  const groups = {};
  for (const kind of Object.keys(KIND_STYLE)) {
    const parts = info.parts.filter((p) => p.kind === kind);
    if (!parts.length) continue;
    let vc = 0, ic = 0;
    for (const p of parts) { vc += p.v[1]; ic += p.i[1]; }
    const P = new Float32Array(vc * 3), N = new Int8Array(vc * 3), S = new Uint8Array(vc * 4), I = new Uint32Array(ic);
    let vo = 0, io = 0;
    for (const p of parts) {
      const [v0, n] = p.v, [i0, m] = p.i;
      P.set(pos.subarray(v0 * 3, (v0 + n) * 3), vo * 3);
      for (let k = 0; k < n; k++) { N[(vo + k) * 3] = nrm[(v0 + k) * 4]; N[(vo + k) * 3 + 1] = nrm[(v0 + k) * 4 + 1]; N[(vo + k) * 3 + 2] = nrm[(v0 + k) * 4 + 2]; }
      S.set(skin.subarray(v0 * 4, (v0 + n) * 4), vo * 4);
      for (let k = 0; k < m; k++) I[io + k] = idx[i0 + k] + vo;
      vo += n; io += m;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3, true));
    g.setAttribute('skin', new THREE.BufferAttribute(S, 4, false));
    g.setIndex(new THREE.BufferAttribute(I, 1));
    groups[kind] = g;
  }
  const v3 = (a) => (a ? new THREE.Vector3(a[0], a[1], a[2]) : null);
  return {
    info, groups,
    pose: info.pose.map(v3),
    hands: { left: info.hands.left.map(v3), right: info.hands.right.map(v3) },
    parts: info.parts.map((p) => ({ ...p, center: v3(p.c) })),
  };
}

// How each kind of tissue is shaded: 0 bone, 1 muscle, 2 vessel/nerve, 3 organ
const SHADE = (k) => (k === 'bone' ? 0 : k === 'muscle' ? 1 : k === 'artery' || k === 'vein' || k === 'nerve' ? 2 : 3);

const VERT = `
uniform mat4 uSeg[${SEG_COUNT}];
in vec4 skin;
out vec3 vN;
out vec3 vP;
out vec3 vR;
void main() {
  int a = int(skin.x + 0.5), b = int(skin.y + 0.5);
  float w = skin.z / 255.0;
  mat4 M = uSeg[a] * (1.0 - w) + uSeg[b] * w;
  vec4 p = M * vec4(position, 1.0);
  vN = normalize(mat3(M) * normal);
  vP = p.xyz;
  vR = position;
  gl_Position = projectionMatrix * viewMatrix * p;
}`;

const NOISE = `
float h3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float n3(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z); }
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 finish(vec3 c) { c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14); return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)); }
`;

// Tissue surfaces: lit like the room (exposure follows the camera), wet highlights, soft light
// bleeding through organs and muscle, a warm bounce from the surrounding flesh, fine surface detail.
const FRAG = `
precision highp float;
uniform vec3 uColor;
uniform float uAlpha, uPeel, uUseMask, uFade, uShade, uExposure;
uniform sampler2D uMask;
uniform vec2 uRes;
uniform vec4 uBox;
in vec3 vN;
in vec3 vP;
in vec3 vR;
out vec4 outColor;
${NOISE}
void main() {
  float m = uUseMask > 0.5 ? texture(uMask, gl_FragCoord.xy / uRes).r : 1.0;
  if (m < 0.02) discard;
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  bool bone = uShade < 0.5, muscle = abs(uShade - 1.0) < 0.5, vessel = abs(uShade - 2.0) < 0.5;
  // fine surface relief: pores on bone, fibres on muscle, a soft mottle elsewhere
  vec3 q = vR * (bone ? 0.9 : 0.35);
  if (muscle) q = vR * vec3(0.9, 0.12, 0.9);
  float e = 0.35, h0 = n3(q);
  vec3 g = vec3(n3(q + vec3(e, 0, 0)) - h0, n3(q + vec3(0, e, 0)) - h0, n3(q + vec3(0, 0, e)) - h0);
  n = normalize(n - (g - n * dot(g, n)) * (bone ? 0.9 : 0.6));
  vec3 alb = toLinear(uColor);
  float mott = n3(vR * 0.04) * 0.6 + n3(vR * 0.15) * 0.4;
  if (bone) alb *= mix(vec3(0.86, 0.80, 0.72), vec3(1.06, 1.03, 0.98), mott);
  else alb *= 0.85 + 0.3 * mott;
  vec3 L = normalize(vec3(-0.45, 0.62, 0.65)), V = vec3(0.0, 0.0, 1.0), Hh = normalize(L + V);
  float wrap = bone ? 0.25 : 0.55;
  float dif = max((dot(n, L) + wrap) / (1.0 + wrap), 0.0);
  vec3 sky = vec3(0.62, 0.60, 0.60), ground = vec3(0.42, 0.10, 0.08);
  vec3 amb = mix(ground, sky, n.y * 0.5 + 0.5) * 0.55;
  float fres = pow(1.0 - max(n.z, 0.0), 4.0);
  float spec = pow(max(dot(n, Hh), 0.0), bone ? 48.0 : 90.0) * (bone ? 0.35 : 0.7) + fres * (bone ? 0.05 : 0.12);
  vec3 c = alb * (amb + dif * vec3(1.05, 1.0, 0.95)) + spec * vec3(1.0, 0.97, 0.94);
  if (!bone) c += alb * (1.0 - dif) * 0.25 * vec3(1.0, 0.45, 0.4);       // light bleeding through tissue
  c += pow(1.0 - abs(n.z), 3.0) * vec3(0.35, 0.06, 0.05) * (bone ? 0.35 : 0.15); // flesh-tinted edges
  if (vessel) c *= 0.9;
  c *= uExposure;
  float a = uAlpha;
  if (uPeel > 0.0 && uUseMask > 0.5) {
    // Muscle thins toward the middle of the opening, so you see down to vessels and bone.
    vec2 bc = (uBox.xy + uBox.zw) * 0.5, hs = (uBox.zw - uBox.xy) * 0.5;
    float r = length((vP.xy - bc) / hs);
    a *= mix(uPeel, 1.0, smoothstep(0.25, 0.95, r));
  }
  // The cut edge of the opening casts a soft shadow inward.
  c *= mix(0.25, 1.0, smoothstep(0.12, 0.85, m));
  outColor = vec4(finish(c), a * smoothstep(0.02, 0.25, m) * uFade);
}`;

// Bone silhouettes, drawn small and blurred into soft shadows on the flesh behind them.
const SIL_FRAG = `
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(1.0); }`;

// The opening: a real cut. From the outside in: the person's own skin (from the camera picture),
// dermis, yellow fat, a thin white fascia, then wet muscle. The walls are lit from the room's
// light direction, and the bones cast soft shadows onto the muscle.
const CAV_VERT = `
uniform vec4 uBox;
out vec2 vS;
void main() { vec2 p = mix(uBox.xy, uBox.zw, position.xy * 0.5 + 0.5); vS = p; gl_Position = projectionMatrix * vec4(p, 0.0, 1.0); }`;
const CAV_FRAG = `
precision highp float;
uniform sampler2D uMask, uCam, uShadow;
uniform vec2 uRes, uStage, uFiber;
uniform float uFade, uHasCam, uExposure, uDpr;
uniform vec4 uBox, uCamRect;
in vec2 vS;
out vec4 outColor;
${NOISE}
void main() {
  vec2 fc = gl_FragCoord.xy / uRes;
  float m = texture(uMask, fc).r;
  if (m < 0.02) discard;
  // the wall's slope from how fast the mask rises: lit on the side facing the light
  vec2 gm = vec2(dFdx(m), dFdy(m)) * 40.0;
  vec3 wn = normalize(vec3(-gm, 1.0));
  vec3 L = normalize(vec3(-0.45, 0.62, 0.65));
  float wallLight = clamp(dot(wn, L) * 1.1, 0.25, 1.4);
  // irregular cut: the layer boundaries wander a little
  float mm = m + (n2(vS * 0.11) - 0.5) * 0.06 + (n2(vS * 0.4) - 0.5) * 0.02;
  // ---- muscle: bundles of fibres running along the limb, wet, with seams between bundles ----
  vec2 dir = normalize(uFiber), perp = vec2(-dir.y, dir.x);
  vec2 warp = vec2(n2(vS * 0.02), n2(vS * 0.02 + 5.0)) * 18.0;
  vec2 fp = vec2(dot(vS + warp, perp), dot(vS + warp, dir));
  float bundle = n2(vec2(fp.x * 0.09, fp.y * 0.012));
  float fibre = n2(vec2(fp.x * 0.9, fp.y * 0.05)) * 0.6 + n2(vec2(fp.x * 2.1, fp.y * 0.11)) * 0.4;
  float seam = smoothstep(0.08, 0.0, abs(bundle - 0.5) - 0.02);
  float hgt = bundle * 0.7 + fibre * 0.3 - seam * 0.5;
  vec3 mus = mix(vec3(0.16, 0.018, 0.016), vec3(0.42, 0.055, 0.045), clamp(bundle * 0.6 + fibre * 0.55, 0.0, 1.0));
  mus = mix(mus, vec3(0.07, 0.006, 0.006), seam * 0.8);
  mus *= 0.85 + 0.3 * n2(vS * 0.03 + 11.0);
  vec2 dh = vec2(dFdx(hgt), dFdy(hgt)) * 6.0 / uDpr;
  vec3 mn = normalize(vec3(-dh, 1.0));
  float mdif = max(dot(mn, L), 0.0) * 0.6 + 0.55;
  float glint = pow(max(dot(mn, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 60.0) * 0.55;
  vec3 c = mus * mdif + vec3(1.0, 0.92, 0.88) * glint;
  c *= mix(1.0, 0.72, smoothstep(0.45, 1.0, m));                 // deeper toward the middle
  // ---- shadows of the bones on the muscle: a sharp-ish cast shadow plus a wide soft one ----
  vec2 off = vec2(14.0, -18.0) * uDpr / uRes, px = 8.0 * uDpr / uRes, px2 = 22.0 * uDpr / uRes;
  float sh = texture(uShadow, fc - off).r * 0.3
    + (texture(uShadow, fc - off + vec2(px.x, 0.0)).r + texture(uShadow, fc - off - vec2(px.x, 0.0)).r
     + texture(uShadow, fc - off + vec2(0.0, px.y)).r + texture(uShadow, fc - off - vec2(0.0, px.y)).r) * 0.175;
  float ao = (texture(uShadow, fc + vec2(px2.x, 0.0)).r + texture(uShadow, fc - vec2(px2.x, 0.0)).r
     + texture(uShadow, fc + vec2(0.0, px2.y)).r + texture(uShadow, fc - vec2(0.0, px2.y)).r) * 0.25;
  c *= (1.0 - 0.8 * sh) * (1.0 - 0.5 * ao);
  // ---- the cut wall: skin (the person's own colour), dermis, fat lobules, fascia ----
  vec3 skin = vec3(0.78, 0.55, 0.46);
  if (uHasCam > 0.5) {
    vec2 css = vec2(vS.x + uStage.x * 0.5, uStage.y * 0.5 - vS.y);
    skin = texture(uCam, (css - uCamRect.xy) / uCamRect.zw).rgb;
  }
  vec2 cell = vS * 0.13 + vec2(n2(vS * 0.05), n2(vS * 0.05 + 3.0)) * 2.0;
  float lob = n2(cell), lobSeam = smoothstep(0.06, 0.0, abs(n2(cell * 1.7) - 0.5) - 0.01);
  vec3 fat = mix(vec3(0.86, 0.66, 0.34), vec3(0.98, 0.86, 0.58), lob);
  fat = mix(fat, vec3(0.75, 0.38, 0.28), lobSeam * 0.6);              // tiny vessels between lobules
  vec3 wall = toLinear(skin) * 0.9;
  wall = mix(wall, toLinear(vec3(0.82, 0.52, 0.47)), smoothstep(0.05, 0.075, mm));
  wall = mix(wall, toLinear(fat), smoothstep(0.085, 0.11, mm));
  wall = mix(wall, toLinear(vec3(0.86, 0.80, 0.78)), smoothstep(0.27, 0.29, mm) * (1.0 - smoothstep(0.30, 0.33, mm)));
  wall *= wallLight * mix(1.05, 0.55, smoothstep(0.08, 0.33, mm));    // the wall falls away into shadow
  float wallMix = 1.0 - smoothstep(0.30, 0.345, mm);
  c = mix(c * mix(0.35, 1.0, smoothstep(0.32, 0.62, mm)), wall, wallMix);
  c *= uExposure;
  outColor = vec4(finish(c), smoothstep(0.02, 0.08, m) * uFade);
}`;

export class ArmView {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -6000, 6000);
    this.seg = Array.from({ length: SEG_COUNT }, () => new THREE.Matrix4());
    this.maskCanvas = document.createElement('canvas');
    this.maskTex = new THREE.CanvasTexture(this.maskCanvas);
    this.maskTex.minFilter = this.maskTex.magFilter = THREE.LinearFilter;
    this.shadowRT = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.shared = {
      uSeg: { value: this.seg }, uMask: { value: this.maskTex }, uRes: { value: new THREE.Vector2(1, 1) },
      uBox: { value: new THREE.Vector4() }, uUseMask: { value: 1 }, uFade: { value: 1 },
      uCam: { value: null }, uCamRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uStage: { value: new THREE.Vector2(1, 1) }, uHasCam: { value: 0 },
      uExposure: { value: 1 }, uShadow: { value: this.shadowRT.texture }, uFiber: { value: new THREE.Vector2(0, 1) }, uDpr: { value: 1 },
    };
    this.cavity = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: this.shared, vertexShader: CAV_VERT, fragmentShader: CAV_FRAG,
      transparent: true, depthTest: false, depthWrite: false,
    }));
    this.cavity.frustumCulled = false; this.cavity.renderOrder = 0;
    this.silMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: this.shared, vertexShader: VERT, fragmentShader: SIL_FRAG, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    this.meshes = {};
    this.visible = { bone: true, artery: true, vein: true, nerve: true, organ: true, muscle: true, tissue: false };
  }
  setModel(arm) {
    for (const m of Object.values(this.meshes)) { this.scene.remove(m); m.material.dispose(); }
    this.scene.remove(this.cavity);
    this.meshes = {};
    this.arm = arm;
    this.scene.add(this.cavity);
    for (const [kind, g] of Object.entries(arm.groups)) {
      const st = KIND_STYLE[kind];
      const opaque = st.alpha >= 1;
      const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG,
        uniforms: { ...this.shared, uColor: { value: new THREE.Color(...st.color) }, uAlpha: { value: st.alpha }, uPeel: { value: st.peel }, uShade: { value: SHADE(kind) } },
        transparent: true, depthWrite: opaque, depthTest: true, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false; mesh.renderOrder = st.order; mesh.userData.kind = kind;
      this.scene.add(mesh); this.meshes[kind] = mesh;
    }
  }
  /** The live camera picture (video or canvas): the skin colour at the cut edge comes from it. */
  setSource(el) {
    if (this.srcEl === el) return;
    if (this.camTex) this.camTex.dispose();
    this.srcEl = el;
    this.camTex = el ? (el instanceof HTMLVideoElement ? new THREE.VideoTexture(el) : new THREE.CanvasTexture(el)) : null;
    if (this.camTex) { this.camTex.flipY = false; this.camTex.minFilter = this.camTex.magFilter = THREE.LinearFilter; this.camTex.generateMipmaps = false; }
    this.shared.uCam.value = this.camTex; this.shared.uHasCam.value = el ? 1 : 0;
  }
  /**
   * Draw. box: screen px {x0,y0,x1,y1} (centre origin, y up).
   * opts: mask (clip to the opening), fade, cavity, cam (picture placement), exposure, fiber (screen dir).
   */
  render(W, H, box, { mask = true, fade = 1, cavity = true, cam = null, exposure = 1, fiber = null } = {}) {
    const r = this.renderer, s = this.shared;
    const buf = r.getDrawingBufferSize(new THREE.Vector2());
    s.uRes.value.copy(buf); s.uDpr.value = r.getPixelRatio(); s.uStage.value.set(W, H);
    s.uBox.value.set(box.x0, box.y0, box.x1, box.y1);
    s.uUseMask.value = mask ? 1 : 0; s.uFade.value = fade; s.uExposure.value = exposure;
    if (cam) s.uCamRect.value.set(cam.ox, cam.oy, cam.dw, cam.dh);
    if (fiber) s.uFiber.value.set(fiber.x, fiber.y);
    if (this.camTex && !(this.srcEl instanceof HTMLVideoElement)) this.camTex.needsUpdate = true;
    for (const [kind, m] of Object.entries(this.meshes)) m.visible = !!this.visible[GROUP(kind)] && fade > 0.002;
    this.camera.left = -W / 2; this.camera.right = W / 2; this.camera.top = H / 2; this.camera.bottom = -H / 2;
    this.camera.updateProjectionMatrix();
    this.cavity.visible = cavity && mask;
    if (this.cavity.visible) {
      // bone silhouettes into a small target, for the soft shadows on the flesh
      const sw = Math.max(4, Math.round(buf.x / 3)), sh = Math.max(4, Math.round(buf.y / 3));
      if (this.shadowRT.width !== sw || this.shadowRT.height !== sh) this.shadowRT.setSize(sw, sh);
      const saved = new Map();
      for (const m of Object.values(this.meshes)) { saved.set(m, m.material); m.material = this.silMat; if (m.userData.kind !== 'bone') m.visible = false; }
      this.cavity.visible = false;
      r.setRenderTarget(this.shadowRT); r.setClearColor(0x000000, 1); r.clear(); r.render(this.scene, this.camera);
      r.setRenderTarget(null); r.setClearColor(0x000000, 0);
      for (const [m, mat] of saved) { m.material = mat; m.visible = !!this.visible[GROUP(m.userData.kind)] && fade > 0.002; }
      this.cavity.visible = true;
    }
    // Only the window needs drawing in the camera view: saves a lot of work on a phone.
    if (mask) {
      r.setScissorTest(true);
      r.setScissor(W / 2 + box.x0 - 2, H / 2 + box.y0 - 2, box.x1 - box.x0 + 4, box.y1 - box.y0 + 4);
    }
    r.render(this.scene, this.camera);
    r.setScissorTest(false);
  }
  /**
   * Paint the opening mask: the user's arm silhouette (fingers, palm, forearm) inside the window.
   * shapes: {caps: [[x0,y0,x1,y1,width],...], polys: [[[x,y],...],...]} in CSS px (top-left origin).
   */
  paintMask(W, H, box, shapes, outline = null, scale = 0.5) {
    const c = this.maskCanvas, w = Math.max(2, Math.round(W * scale)), h = Math.max(2, Math.round(H * scale));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; this.maskTex.dispose(); this.maskTex = new THREE.CanvasTexture(c); this.maskTex.minFilter = this.maskTex.magFilter = THREE.LinearFilter; this.shared.uMask.value = this.maskTex; }
    const x = c.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, w, h);
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.save();
    x.scale(scale, scale);
    // Inside the window only, with soft edges. The shapes are drawn far off-canvas and only their
    // blurred shadow lands on the canvas (works everywhere, unlike ctx.filter).
    x.beginPath(); x.rect(W / 2 + box.x0, H / 2 - box.y1, box.x1 - box.x0, box.y1 - box.y0); x.clip();
    const OFF = 20000;
    x.shadowColor = '#fff'; x.shadowBlur = 14 * scale * 2; x.shadowOffsetX = OFF * scale;
    x.translate(-OFF, 0);
    x.fillStyle = '#fff'; x.strokeStyle = '#fff'; x.lineCap = 'round'; x.lineJoin = 'round';
    for (const poly of shapes.polys) { x.beginPath(); poly.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py))); x.closePath(); x.fill(); }
    for (const [x0, y0, x1, y1, lw] of shapes.caps) { x.lineWidth = lw; x.beginPath(); x.moveTo(x0, y0); x.lineTo(x1, y1); x.stroke(); }
    // Body outline from segmentation: an image whose alpha is "person", placed at {x, y, w, h} CSS px.
    if (outline) {
      x.save();
      const M = outline.M; // extra move picked up from optical flow while the body tracker can't see
      if (M) x.transform(M.a, M.b, M.c, M.d, M.e, M.f);
      x.drawImage(outline.canvas, outline.x, outline.y, outline.w, outline.h);
      x.restore();
    }
    x.restore();
    // Shrink slightly so the anatomy sits inside the real skin, and fade at the window's border.
    this.maskTex.needsUpdate = true;
  }
}
