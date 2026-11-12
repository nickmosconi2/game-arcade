// Volume renderer for the "X-ray window". Ray-marches the CT through the window on screen,
// lined up with the tracked arm, and turns CT numbers into something anyone can read:
//   Anatomy view: ivory, lit bones inside red muscle, skin and fat left out.
//   X-ray view:   a classic radiograph (dense bone bright, soft tissue faint).
import * as THREE from './vendor/three.module.min.js';

const VERT = `
out vec2 vScreen;
uniform vec4 uBox;          // x0, y0, x1, y1 in screen px, origin at centre, y up
void main() {
  vec2 p = mix(uBox.xy, uBox.zw, position.xy * 0.5 + 0.5);
  vScreen = p;
  gl_Position = projectionMatrix * vec4(p, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
precision highp sampler3D;
in vec2 vScreen;
out vec4 outColor;
uniform sampler3D uVol;
uniform mat4 uScreenToTex;
uniform float uZ;               // rays run from screen z = +uZ to -uZ
uniform float uRayMm;           // that full ray length in mm
uniform float uMode;            // 0 = anatomy, 1 = X-ray
uniform float uFade;
uniform float uFrame;           // 1 = draw the window tint and scan line
uniform vec4 uBox;
uniform float uTime;
uniform vec3 uLightTex;
uniform vec3 uViewTex;
uniform vec3 uTexel;
const int STEPS = 220;

float hu(vec3 t) { return -1024.0 + texture(uVol, t).r * 3024.0; }
vec3 grad(vec3 p) {
  return vec3(hu(p + vec3(uTexel.x, 0, 0)) - hu(p - vec3(uTexel.x, 0, 0)),
              hu(p + vec3(0, uTexel.y, 0)) - hu(p - vec3(0, uTexel.y, 0)),
              hu(p + vec3(0, 0, uTexel.z)) - hu(p - vec3(0, 0, uTexel.z)));
}

void main() {
  vec3 a = (uScreenToTex * vec4(vScreen, uZ, 1.0)).xyz;
  vec3 b = (uScreenToTex * vec4(vScreen, -uZ, 1.0)).xyz;
  vec3 d = b - a;
  vec3 inv = 1.0 / d;
  vec3 t0 = -a * inv, t1 = (vec3(1.0) - a) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  float tf = min(min(tmax.x, tmax.y), min(tmax.z, 1.0));

  float edge = min(min(vScreen.x - uBox.x, uBox.z - vScreen.x), min(vScreen.y - uBox.y, uBox.w - vScreen.y));
  float inner = smoothstep(0.0, 26.0, edge);
  float span = uBox.w - uBox.y;
  float line = uFrame * exp(-pow((vScreen.y - (uBox.y + fract(uTime * 0.3) * span)) / 2.5, 2.0)) * 0.35;

  vec3 col = vec3(0.0); float alpha = 0.0;
  if (tf > tn) {
    float lenMm = (tf - tn) * uRayMm;
    int n = int(clamp(lenMm / 0.8, 16.0, float(STEPS)));
    float dt = (tf - tn) / float(n), stepMm = lenMm / float(n);
    float jitter = fract(sin(dot(vScreen, vec2(12.9898, 78.233))) * 43758.5453);
    if (uMode < 0.5) {
      for (int i = 0; i < STEPS; i++) {
        if (i >= n || alpha > 0.97) break;
        vec3 p = a + d * (tn + (float(i) + jitter) * dt);
        float h = hu(p);
        vec3 ed = min(p, 1.0 - p) / uTexel;                       // distance to the scan's edge, in voxels
        float cut = smoothstep(1.0, 9.0, min(min(ed.x, ed.y), ed.z));
        float aBone = smoothstep(170.0, 380.0, h) * cut;
        float aMus = smoothstep(-10.0, 45.0, h) * (1.0 - aBone) * 0.035 * cut;
        if (aBone + aMus < 0.002) continue;
        vec3 c; float sa;
        if (aBone > 0.01) {
          vec3 g = grad(p);                      // lighting only where it shows: on bone
          vec3 nrm = normalize(-g / uTexel + 1e-4);
          if (dot(nrm, uViewTex) > 0.0) nrm = -nrm;
          float dif = max(dot(nrm, uLightTex), 0.0);
          float back = max(dot(nrm, -uLightTex), 0.0);
          float spec = pow(max(dot(reflect(-uLightTex, nrm), -uViewTex), 0.0), 24.0);
          float dense = smoothstep(500.0, 1200.0, h);
          c = mix(vec3(0.93, 0.86, 0.70), vec3(0.98, 0.96, 0.90), dense) * (0.30 + 0.72 * dif + 0.12 * back) + spec * 0.25;
          sa = 1.0 - pow(1.0 - aBone * 0.85, stepMm);
        } else {
          float fib = 0.86 + 0.14 * sin(dot(p / uTexel, vec3(0.7, 1.3, 0.4)));
          float lean = smoothstep(20.0, 70.0, h);            // denser muscle reads a little brighter
          c = vec3(0.80, 0.18, 0.15) * fib * (0.70 + 0.25 * lean);
          sa = 1.0 - pow(1.0 - aMus, stepMm);
        }
        col += (1.0 - alpha) * sa * c;
        alpha += (1.0 - alpha) * sa;
      }
      if (alpha > 0.0) col /= alpha;
    } else {
      float soft = 0.0, bone = 0.0;
      for (int i = 0; i < STEPS; i++) {
        if (i >= n) break;
        float h = hu(a + d * (tn + (float(i) + jitter) * dt));
        soft += smoothstep(-500.0, -100.0, h) * stepMm;
        bone += max(h - 160.0, 0.0) * stepMm;
      }
      float xr = 1.0 - exp(-(bone * 0.00012 + soft * 0.004));
      float bo = 1.0 - exp(-bone * 0.00018);
      col = vec3(0.04, 0.06, 0.10) + vec3(0.50, 0.66, 0.86) * xr * 0.55 + vec3(0.96, 0.98, 1.0) * pow(bo, 0.8) * 0.95;
      alpha = 0.86;
    }
  } else if (uMode > 0.5) {
    col = vec3(0.04, 0.06, 0.10); alpha = 0.86;
  }
  // Inside the window but off the arm: a light tint so the window reads as a "lens".
  float tintA = 0.30 * uFrame;
  vec3 tint = vec3(0.02, 0.06, 0.10);
  vec3 outc = col * alpha + (1.0 - alpha) * tint * tintA;
  float outa = alpha + (1.0 - alpha) * tintA;
  outc = outc / max(outa, 1e-3) + vec3(0.45, 0.85, 1.0) * line;
  outColor = vec4(outc, clamp(outa + line, 0.0, 1.0) * uFade * mix(1.0, inner, uFrame));
}`;

export class VolumeView {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
    this.uniforms = {
      uVol: { value: null }, uScreenToTex: { value: new THREE.Matrix4() }, uZ: { value: 400 }, uRayMm: { value: 600 },
      uMode: { value: 0 }, uFade: { value: 0 }, uFrame: { value: 1 }, uBox: { value: new THREE.Vector4() }, uTime: { value: 0 },
      uLightTex: { value: new THREE.Vector3(0, 0, 1) }, uViewTex: { value: new THREE.Vector3(0, 0, -1) }, uTexel: { value: new THREE.Vector3(0.01, 0.01, 0.01) },
    };
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthTest: false, depthWrite: false,
    }));
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.size = new THREE.Vector3(1, 1, 1);
  }
  /** vol: {data Int16Array (HU), dims [nx,ny,nz], spacing [sx,sy,sz]} */
  setVolume(vol) {
    const [nx, ny, nz] = vol.dims, n = nx * ny * nz, bytes = new Uint8Array(n), src = vol.data;
    for (let i = 0; i < n; i++) { const v = (src[i] + 1024) * (255 / 3024); bytes[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
    if (this.tex) this.tex.dispose();
    const tex = new THREE.Data3DTexture(bytes, nx, ny, nz);
    tex.format = THREE.RedFormat; tex.type = THREE.UnsignedByteType;
    tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.unpackAlignment = 1; tex.needsUpdate = true;
    this.tex = tex;
    this.uniforms.uVol.value = tex;
    this.size.set(nx * vol.spacing[0], ny * vol.spacing[1], nz * vol.spacing[2]);
    this.uniforms.uTexel.value.set(1 / nx, 1 / ny, 1 / nz);
  }
  /**
   * model: Matrix4 from volume mm to screen px (centre origin, y up).
   * box: {x0, y0, x1, y1} in the same screen px. frame: draw the window tint and scan line.
   */
  render(model, box, W, H, { fade = 1, mode = 0, time = 0, frame = true } = {}) {
    if (!this.tex) return;
    const u = this.uniforms;
    const toTex = new THREE.Matrix4().makeScale(1 / this.size.x, 1 / this.size.y, 1 / this.size.z);
    u.uScreenToTex.value.copy(toTex).multiply(model.clone().invert());
    const s = new THREE.Vector3(); model.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    const pxPerMm = Math.max(1e-3, Math.abs(s.y));
    u.uZ.value = 320 * pxPerMm; u.uRayMm.value = 640;
    u.uBox.value.set(box.x0, box.y0, box.x1, box.y1);
    u.uFade.value = fade; u.uMode.value = mode; u.uTime.value = time; u.uFrame.value = frame ? 1 : 0;
    // Directions in texture space for lighting: use the inverse-transpose so shading stays right
    // when the scan is mirrored or scaled.
    const m3 = new THREE.Matrix3().setFromMatrix4(u.uScreenToTex.value);
    u.uLightTex.value.set(-0.35, 0.55, 0.76).applyMatrix3(m3).normalize();
    u.uViewTex.value.set(0, 0, -1).applyMatrix3(m3).normalize();
    this.camera.left = -W / 2; this.camera.right = W / 2; this.camera.top = H / 2; this.camera.bottom = -H / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }
}
