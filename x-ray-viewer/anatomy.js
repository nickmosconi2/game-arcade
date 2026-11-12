// Anatomical arm model (BodyParts3D 4.0, CC BY 4.0) and its renderer.
// Every vertex is bound to one or two "segments" (forearm, palm, and each finger bone), so the
// model can be posed bone by bone from the user's tracked hand.
import * as THREE from './vendor/three.module.min.js';

export const SEG_COUNT = 17;
export const KIND_STYLE = {
  bone:   { color: [0.93, 0.88, 0.76], alpha: 1.0, order: 2, peel: 0 },
  artery: { color: [0.86, 0.10, 0.12], alpha: 1.0, order: 3, peel: 0 },
  vein:   { color: [0.20, 0.32, 0.86], alpha: 1.0, order: 3, peel: 0 },
  muscle: { color: [0.74, 0.20, 0.17], alpha: 0.88, order: 5, peel: 0.18 },
  tissue: { color: [0.90, 0.85, 0.80], alpha: 0.55, order: 4, peel: 0.3 },
};

/** Load one arm ('left' | 'right'): geometry per tissue kind plus the rest-pose joints. */
export async function loadArm(side, base = 'models') {
  const [info, buf] = await Promise.all([
    fetch(`${base}/arm-${side}.json`).then((r) => { if (!r.ok) throw new Error(`model not found (${r.status})`); return r.json(); }),
    fetch(`${base}/arm-${side}.bin`).then((r) => r.arrayBuffer()),
  ]);
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
  const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  return {
    side, info, groups,
    joints: info.landmarks.map(v3), elbow: v3(info.elbow),
    parts: info.parts.map((p) => ({ ...p, center: v3(p.c) })),
  };
}

const VERT = `
uniform mat4 uSeg[${SEG_COUNT}];
in vec4 skin;
out vec3 vN;
out vec3 vP;
void main() {
  int a = int(skin.x + 0.5), b = int(skin.y + 0.5);
  float w = skin.z / 255.0;
  mat4 M = uSeg[a] * (1.0 - w) + uSeg[b] * w;
  vec4 p = M * vec4(position, 1.0);
  vN = normalize(mat3(M) * normal);
  vP = p.xyz;
  gl_Position = projectionMatrix * viewMatrix * p;
}`;

const FRAG = `
precision highp float;
uniform vec3 uColor;
uniform float uAlpha, uPeel, uXray, uUseMask, uFade;
uniform sampler2D uMask;
uniform vec2 uRes;
uniform vec4 uBox;
in vec3 vN;
in vec3 vP;
out vec4 outColor;
void main() {
  float m = uUseMask > 0.5 ? texture(uMask, gl_FragCoord.xy / uRes).r : 1.0;
  if (m < 0.02) discard;
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 L = normalize(vec3(-0.35, 0.55, 0.76));
  float dif = max(dot(n, L), 0.0), rim = pow(1.0 - abs(n.z), 2.0);
  float spec = pow(max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 36.0);
  vec3 c = uColor * (0.32 + 0.78 * dif) + spec * 0.28;
  float a = uAlpha;
  if (uPeel > 0.0 && uUseMask > 0.5) {
    // Muscle thins toward the middle of the opening, so you see down to vessels and bone.
    vec2 bc = (uBox.xy + uBox.zw) * 0.5, hs = (uBox.zw - uBox.xy) * 0.5;
    float r = length((vP.xy - bc) / hs);
    a *= mix(uPeel, 1.0, smoothstep(0.25, 0.95, r));
    a = max(a, rim * 0.55 * uAlpha);
  }
  if (uXray > 0.5) {
    c = vec3(0.78, 0.9, 1.0) * (0.22 + 1.0 * rim);
    a = (0.22 + 0.78 * rim) * uAlpha;
  }
  // Depth cue: the cut edge of the opening casts a soft shadow inward.
  c *= mix(0.3, 1.0, smoothstep(0.12, 0.8, m));
  outColor = vec4(c, a * smoothstep(0.02, 0.25, m) * uFade);
}`;

// The opening itself: dark tissue inside, a cut rim of skin and fat at the edge.
const CAV_VERT = `
uniform vec4 uBox;
out vec2 vS;
void main() { vec2 p = mix(uBox.xy, uBox.zw, position.xy * 0.5 + 0.5); vS = p; gl_Position = projectionMatrix * vec4(p, 0.0, 1.0); }`;
const CAV_FRAG = `
precision highp float;
uniform sampler2D uMask;
uniform vec2 uRes;
uniform float uFade, uXray, uTime;
uniform vec4 uBox;
in vec2 vS;
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
void main() {
  float m = texture(uMask, gl_FragCoord.xy / uRes).r;
  if (m < 0.02) discard;
  float rimBand = 1.0 - smoothstep(0.18, 0.55, m);
  vec3 deep = uXray > 0.5 ? vec3(0.02, 0.04, 0.08) : mix(vec3(0.10, 0.015, 0.02), vec3(0.22, 0.04, 0.04), noise(vS * 0.05) * 0.7 + noise(vS * 0.2) * 0.3);
  vec3 fat = vec3(0.96, 0.82, 0.55), skin = vec3(0.90, 0.62, 0.55);
  vec3 rimCol = mix(skin, fat, smoothstep(0.05, 0.3, m));
  vec3 c = mix(deep, rimCol, rimBand * (uXray > 0.5 ? 0.25 : 0.85));
  // a faint scan line sweeping through the opening
  float span = uBox.w - uBox.y;
  float line = exp(-pow((vS.y - (uBox.y + fract(uTime * 0.3) * span)) / 2.5, 2.0)) * 0.3;
  c += vec3(0.45, 0.85, 1.0) * line;
  outColor = vec4(c, smoothstep(0.02, 0.22, m) * uFade);
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
    this.shared = {
      uSeg: { value: this.seg }, uMask: { value: this.maskTex }, uRes: { value: new THREE.Vector2(1, 1) },
      uBox: { value: new THREE.Vector4() }, uUseMask: { value: 1 }, uXray: { value: 0 }, uFade: { value: 1 }, uTime: { value: 0 },
    };
    this.cavity = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: this.shared, vertexShader: CAV_VERT, fragmentShader: CAV_FRAG,
      transparent: true, depthTest: false, depthWrite: false,
    }));
    this.cavity.frustumCulled = false; this.cavity.renderOrder = 0;
    this.meshes = {};
    this.visible = { bone: true, artery: true, vein: true, muscle: true, tissue: false };
  }
  setArm(arm) {
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
        uniforms: { ...this.shared, uColor: { value: new THREE.Color(...st.color) }, uAlpha: { value: st.alpha }, uPeel: { value: st.peel } },
        transparent: true, depthWrite: opaque, depthTest: true, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false; mesh.renderOrder = st.order;
      this.scene.add(mesh); this.meshes[kind] = mesh;
    }
  }
  /** Draw the arm. box: screen px {x0,y0,x1,y1} (centre origin, y up). opts: {mask, xray, fade, time, cavity} */
  render(W, H, box, { mask = true, xray = false, fade = 1, time = 0, cavity = true } = {}) {
    const r = this.renderer, s = this.shared;
    const buf = r.getDrawingBufferSize(new THREE.Vector2());
    s.uRes.value.copy(buf);
    s.uBox.value.set(box.x0, box.y0, box.x1, box.y1);
    s.uUseMask.value = mask ? 1 : 0; s.uXray.value = xray ? 1 : 0; s.uFade.value = fade; s.uTime.value = time;
    this.cavity.visible = cavity && mask;
    for (const [kind, m] of Object.entries(this.meshes)) m.visible = !!this.visible[kind] && (!xray || kind === 'bone');
    this.camera.left = -W / 2; this.camera.right = W / 2; this.camera.top = H / 2; this.camera.bottom = -H / 2;
    this.camera.updateProjectionMatrix();
    r.render(this.scene, this.camera);
  }
  /**
   * Paint the opening mask: the user's arm silhouette (fingers, palm, forearm) inside the window.
   * shapes: {caps: [[x0,y0,x1,y1,width],...], polys: [[[x,y],...],...]} in CSS px (top-left origin).
   */
  paintMask(W, H, box, shapes, scale = 0.5) {
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
    x.restore();
    // Shrink slightly so the anatomy sits inside the real skin, and fade at the window's border.
    this.maskTex.needsUpdate = true;
  }
}
