// X-ray Viewer: load a DICOM scan, point the camera at your arm, see inside it.
import * as THREE from './vendor/three.module.min.js';
import { parseDicom, decodeFrame, unzip, isZip, DicomError } from './dicom.js';
import { groupSeries, buildVolume, smooth, surfaceNets, otsu, analyzeLimb, peelSkin } from './volume.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), video = $('video'), c2d = $('c2d'), c3d = $('c3d');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const nextFrame = () => new Promise((r) => setTimeout(r, 0));
const HAND_MM = 92;            // adult wrist-to-middle-knuckle distance, used to judge real-world size
const OTHER_PARTS = /LEG|KNEE|ANKLE|FOOT|TIBIA|FIBULA|FEMUR|HIP|PELVIS|CHEST|THORAX|ABDOMEN|SPINE|HEAD|SKULL|BRAIN|NECK|SHOULDER|TOE|HEEL|CALCANEUS|WHOLE ?BODY/i;

const state = {
  series: [], cur: null, mode: 'cam',
  slice: 0, wc: 40, ww: 400, sliceCache: null,
  view2d: { zoom: 1, x: 0, y: 0 },
  kind: null,                  // 'volume' | 'image'
  frame: null,                 // how the scan sits in a standard pose: {R, wrist, center, length, width}
  trackable: false, whyNot: '',
  show: { bone: true, muscle: true, skin: false },
  orbit: new THREE.Quaternion(), zoom3d: 1, pan3d: new THREE.Vector2(),
  camOn: false, camError: '', source: null, testSource: null,
  tracker: null, trackerState: 'off',
  tracked: false, lastSeen: 0, fade: 0, forearm: null,
};

// ---------- loading ----------
function busy(text) { state.loading = !!text; $('busy').classList.toggle('hidden', !text); if (text) $('busyText').textContent = text; }

async function loadBuffers(items) {
  $('err').textContent = '';
  busy('Reading files…');
  await nextFrame();
  try {
    const raw = [];
    for (const it of items) {
      if (isZip(it.buffer)) raw.push(...await unzip(it.buffer)); else raw.push(it);
    }
    const files = [], reasons = new Map();
    for (const it of raw) {
      try { files.push(parseDicom(it.buffer, it.name.split('/').pop())); }
      catch (e) { if (e instanceof DicomError) reasons.set(e.message, (reasons.get(e.message) || 0) + 1); else throw e; }
    }
    if (!files.length) {
      const why = [...reasons.keys()].filter((r) => r !== 'not DICOM' && r !== 'no image in file')[0];
      throw new DicomError(why || 'No DICOM images found in those files.');
    }
    state.series = groupSeries(files);
    await openSeries(0);
    $('sheet').classList.add('hidden');
    $('closeSheet').hidden = false;
  } catch (e) {
    console.error(e);
    $('err').textContent = e instanceof DicomError ? e.message : `Could not load: ${e.message}`;
  } finally { busy(''); }
}

async function openSeries(i) {
  const s = state.series[i];
  busy('Preparing…');
  await nextFrame();
  state.cur = s;
  state.slice = s.slices.length >> 1;
  state.sliceCache = null;
  state.view2d = { zoom: 1, x: 0, y: 0 };
  const isCT = s.modality === 'CT';
  const px = await decodeFrame(s.slices[state.slice].file, s.slices[state.slice].frame);
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < px.length; k += 3) { if (px[k] < lo) lo = px[k]; if (px[k] > hi) hi = px[k]; }
  s.range = isCT ? [-1024, 3000] : [lo, Math.max(hi, lo + 1)];
  const f = s.first;
  if (isCT && s.isVolume) { state.wc = 300; state.ww = 1500; }
  else if (Number.isFinite(f.windowCenter) && f.windowWidth > 0) { state.wc = f.windowCenter; state.ww = f.windowWidth; }
  else { state.wc = (lo + hi) / 2; state.ww = Math.max(1, hi - lo); }
  setupPresets();
  $('title').textContent = s.description || 'Scan';
  $('slice').max = s.slices.length - 1; $('slice').value = state.slice;
  $('sliceRow').style.display = s.slices.length > 1 ? '' : 'none';

  clearAnatomy();
  state.orbit.identity(); state.zoom3d = 1; state.pan3d.set(0, 0);
  state.tracked = false; state.fade = 0; state.forearm = null;
  const words = `${f.bodyPart || ''} ${f.studyDescription || ''} ${f.seriesDescription || ''}`;
  const otherPart = OTHER_PARTS.test(words);
  if (s.isVolume) {
    let vol = await buildVolume(s, async (p) => { busy(`Building 3D… ${Math.round(p * 100)}%`); await nextFrame(); });
    busy('Finding bone and muscle…'); await nextFrame();
    vol = smooth(vol);
    const bodyIso = isCT ? -300 : otsu(vol.data), boneIso = isCT ? 250 : null;
    addSurface('skin', vol, bodyIso); await nextFrame();
    if (isCT) {
      addSurface('bone', vol, boneIso); await nextFrame();
      addSurface('muscle', peelSkin(vol, bodyIso, 3.5), 10); await nextFrame();
    }
    const limb = analyzeLimb(vol, bodyIso, boneIso);
    state.kind = 'volume';
    state.frame = volumeFrame(limb);
    state.trackable = !!limb && limb.maxWidth < 170 && limb.length > 100 && !otherPart;
    state.whyNot = 'Automatic X-ray vision works for hand, wrist and forearm scans so far. Use 3D or Slices for this one.';
  } else {
    addFilm(s, px);
    state.kind = 'image';
    state.frame = filmFrame(s, px);
    state.trackable = !otherPart;
    state.whyNot = 'Automatic X-ray vision works for hand, wrist and forearm scans so far. Use Slices for this one.';
  }
  state.show = { bone: true, muscle: true, skin: false };
  buildLayerChips();
  setMode(state.trackable ? 'cam' : state.kind === 'volume' ? '3d' : '2d');
  busy('');
}

// ---------- 2D slice view ----------
const off = document.createElement('canvas');
function setupPresets() {
  const s = state.cur, [lo, hi] = s.range, span = hi - lo;
  const presets = s.modality === 'CT'
    ? [['Bone', 300, 1500], ['Soft tissue', 40, 400], ['Lung', -600, 1500]]
    : [['Auto', state.wc, state.ww], ['Brighter', lo + span * 0.3, span * 0.6], ['More contrast', lo + span * 0.5, span * 0.5]];
  const box = $('presets'); box.innerHTML = '';
  presets.forEach(([name, c, w], i) => {
    const b = document.createElement('button'); b.textContent = name; b.classList.toggle('on', i === 0);
    b.onclick = () => {
      state.wc = c; state.ww = w;
      for (const o of box.children) o.classList.toggle('on', o === b);
      draw2d(); refreshFilmTexture();
    };
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
function grayscale(px, s, out, glow) {
  const lo = state.wc - state.ww / 2, k = 255 / state.ww, inv = s.first.inverted;
  for (let i = 0, j = 0; i < px.length; i++, j += 4) {
    let v = (px[i] - lo) * k;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    if (inv) v = 255 - v;
    if (glow) {
      // Camera overlay: empty film is see-through, dense bone glows.
      out[j] = 205 + v * 0.2; out[j + 1] = 228 + v * 0.1; out[j + 2] = 255; out[j + 3] = Math.pow(v / 255, 1.25) * 255;
    } else { out[j] = out[j + 1] = out[j + 2] = v; out[j + 3] = 255; }
  }
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
    grayscale(px, s, img.data, false);
    octx.putImageData(img, 0, 0);
    const dpr = Math.min(window.devicePixelRatio || 1, 2), W = stage.clientWidth, H = stage.clientHeight;
    if (c2d.width !== W * dpr || c2d.height !== H * dpr) { c2d.width = W * dpr; c2d.height = H * dpr; }
    const ctx = c2d.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c2d.width, c2d.height);
    const wmm = s.columns * s.spacing[0], hmm = s.rows * s.spacing[1];
    const fit = Math.min(W / wmm, (H - 170) / hmm) * state.view2d.zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, W / 2 + state.view2d.x - wmm * fit / 2, (H - 40) / 2 + state.view2d.y - hmm * fit / 2, wmm * fit, hmm * fit);
    $('sliceOut').textContent = `${state.slice + 1}/${s.slices.length}`;
  } finally {
    drawing = false;
    if (drawAgain) { drawAgain = false; draw2d(); }
  }
}

// ---------- 3D scene ----------
const renderer = new THREE.WebGLRenderer({ canvas: c3d, alpha: true, antialias: true });
renderer.setClearColor(0x000000, 0);
renderer.autoClear = false;
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20000);
camera.position.z = 10000;
const pose = new THREE.Group(), anatomy = new THREE.Group();
anatomy.matrixAutoUpdate = false;
scene.add(pose); pose.add(anatomy);
const maskTarget = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: true });
const meshes = {};   // skin, bone, muscle, film
let filmTexture = null, filmCanvas = null, filmSource = null;

// Shared uniforms: the "window" mask is the arm's own silhouette, soft at the edges,
// so anatomy shows inside the arm and the real skin from the camera remains around it.
const shared = {
  uMask: { value: maskTarget.texture }, uRes: { value: new THREE.Vector2(1, 1) },
  uUseMask: { value: 0 }, uFade: { value: 1 },
  uAxis: { value: new THREE.Vector3(0, 0, 1) }, uSide: { value: new THREE.Vector3(1, 0, 0) },
  uSpan: { value: new THREE.Vector2(-1e6, 1e6) },   // where the scan starts and ends along the arm, in mm
};
const VERT = `
varying vec3 vN; varying vec3 vP;
void main() { vN = normalize(normalMatrix * normal); vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const HEAD = `
precision highp float;
uniform sampler2D uMask; uniform vec2 uRes; uniform float uUseMask; uniform float uFade;
uniform vec3 uAxis; uniform vec3 uSide; uniform vec2 uSpan;
varying vec3 vN; varying vec3 vP;
const vec3 LIGHT = vec3(0.37, 0.56, 0.74);
float windowAt() { return uUseMask > 0.5 ? texture2D(uMask, gl_FragCoord.xy / uRes).r : 1.0; }
vec3 facing() { vec3 n = normalize(vN); return gl_FrontFacing ? n : -n; }`;
const material = (body, opts) => new THREE.ShaderMaterial({ uniforms: shared, vertexShader: VERT, fragmentShader: HEAD + body, transparent: true, ...opts });
const mats = {
  // 1 in the middle of the arm, falling to 0 toward its outline and toward the ends of the scan.
  mask: new THREE.ShaderMaterial({
    uniforms: shared, vertexShader: VERT,
    fragmentShader: HEAD + `
void main() {
  float t = dot(vP, uAxis);
  float ends = smoothstep(0.0, 30.0, t - uSpan.x) * smoothstep(0.0, 30.0, uSpan.y - t);
  float w = smoothstep(0.22, 0.93, abs(normalize(vN).z)) * ends;
  gl_FragColor = vec4(w, w, w, 1.0);
}`,
  }),
  // Camera view: the cut edge of skin and fat fading into the dark interior. 3D view: a faint skin shell.
  skin: material(`
void main() {
  vec3 n = facing();
  if (uUseMask > 0.5) {
    float w = windowAt();
    vec3 c = mix(vec3(0.80, 0.50, 0.42), vec3(0.90, 0.70, 0.42), smoothstep(0.10, 0.32, w));
    c = mix(c, vec3(0.36, 0.05, 0.06), smoothstep(0.30, 0.62, w));
    gl_FragColor = vec4(c, smoothstep(0.0, 0.55, w) * 0.96 * uFade);
  } else {
    float rim = pow(1.0 - abs(n.z), 2.0);
    gl_FragColor = vec4(vec3(0.90, 0.70, 0.60) * (0.6 + 0.4 * max(dot(n, LIGHT), 0.0)), (0.10 + 0.55 * rim) * uFade);
  }
}`, { depthWrite: false, depthTest: false }),
  bone: material(`
void main() {
  vec3 n = facing();
  float d = max(dot(n, LIGHT), 0.0), rim = pow(1.0 - abs(n.z), 2.0);
  float spec = pow(max(reflect(-LIGHT, n).z, 0.0), 28.0);
  vec3 c = vec3(0.94, 0.91, 0.81) * (0.36 + 0.74 * d) - rim * vec3(0.26, 0.24, 0.18) + spec * 0.22;
  gl_FragColor = vec4(c, smoothstep(0.10, 0.60, windowAt()) * uFade);
}`, { side: THREE.DoubleSide }),
  muscle: material(`
void main() {
  vec3 n = facing();
  float d = max(dot(n, LIGHT), 0.0), fres = pow(1.0 - abs(n.z), 1.5);
  float s = dot(vP, uSide) * 1.5 + sin(dot(vP, uAxis) * 0.045) * 3.0;
  float fibre = 0.84 + 0.12 * sin(s) + 0.05 * sin(s * 3.7 + 1.3);
  float spec = pow(max(reflect(-LIGHT, n).z, 0.0), 22.0);
  vec3 c = vec3(0.78, 0.17, 0.14) * (0.40 + 0.80 * d) * fibre + spec * 0.30;
  gl_FragColor = vec4(c, mix(0.34, 0.95, fres) * smoothstep(0.12, 0.62, windowAt()) * uFade);
}`, { depthWrite: false }),
};

function clearAnatomy() {
  for (const c of [...anatomy.children]) { anatomy.remove(c); c.geometry.dispose(); }
  for (const k of Object.keys(meshes)) delete meshes[k];
  if (filmTexture) { filmTexture.dispose(); filmTexture = null; }
  filmSource = null; state.frame = null; state.kind = null;
}
function addSurface(name, vol, iso) {
  const m = surfaceNets(vol, iso);
  if (m.indices.length < 12) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
  geo.computeVertexNormals(); geo.computeBoundingBox();
  const mesh = new THREE.Mesh(geo, mats[name]);
  mesh.renderOrder = { skin: 0, bone: 1, muscle: 2 }[name];
  anatomy.add(mesh);
  meshes[name] = mesh;
}
function addFilm(s, px) {
  const w = s.columns * s.spacing[0], h = s.rows * s.spacing[1];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, w, 0, 0, w, h, 0, 0, h, 0]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 2));
  geo.setIndex([0, 2, 1, 0, 3, 2]); geo.computeBoundingBox();
  const k = Math.min(1, 1024 / Math.max(s.columns, s.rows));   // texture capped at 1024 px for phones
  filmCanvas = document.createElement('canvas');
  filmCanvas.width = Math.round(s.columns * k); filmCanvas.height = Math.round(s.rows * k);
  filmSource = { s, px };
  filmTexture = new THREE.CanvasTexture(filmCanvas);
  filmTexture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: filmTexture, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  anatomy.add(mesh);
  meshes.film = mesh;
  refreshFilmTexture();
}
function refreshFilmTexture() {
  if (!filmSource) return;
  const { s, px } = filmSource;
  const full = document.createElement('canvas'); full.width = s.columns; full.height = s.rows;
  const fctx = full.getContext('2d'), img = fctx.createImageData(s.columns, s.rows);
  grayscale(px, s, img.data, true);
  fctx.putImageData(img, 0, 0);
  const ctx = filmCanvas.getContext('2d');
  ctx.clearRect(0, 0, filmCanvas.width, filmCanvas.height);
  ctx.drawImage(full, 0, 0, filmCanvas.width, filmCanvas.height);
  // Feather the borders so the film melts into the camera picture instead of ending in a hard rectangle.
  const W = filmCanvas.width, H = filmCanvas.height, m = Math.round(Math.min(W, H) * 0.12);
  ctx.globalCompositeOperation = 'destination-out';
  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of [[0, 0, m, 0, 0, 0, m, H], [W, 0, W - m, 0, W - m, 0, m, H], [0, 0, 0, m, 0, 0, W, m], [0, H, 0, H - m, 0, H - m, W, m]]) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(rx, ry, rw, rh);
  }
  ctx.globalCompositeOperation = 'source-over';
  filmTexture.needsUpdate = true;
}

/** Standard pose for a 3D scan: Y toward the fingers, X toward the thumb, origin at the wrist. */
function volumeFrame(limb) {
  const box = new THREE.Box3();
  for (const m of Object.values(meshes)) box.union(m.geometry.boundingBox);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  let y, x;
  const useLimb = limb && limb.maxWidth < 170;
  if (useLimb) {
    y = new THREE.Vector3(...limb.distal);
    x = limb.thumb ? new THREE.Vector3(...limb.thumb) : new THREE.Vector3(1, 0, 0);
  } else {
    const long = size.toArray().indexOf(Math.max(size.x, size.y, size.z));
    y = new THREE.Vector3().setComponent(long, 1);                 // head end up for a body scan
    x = new THREE.Vector3().setComponent(long === 0 ? 1 : 0, 1);   // patient's left on the viewer's right
  }
  x.addScaledVector(y, -x.dot(y)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  shared.uAxis.value.copy(y); shared.uSide.value.copy(x);
  let lo = Infinity, hi = -Infinity;
  const pos = (meshes.skin || Object.values(meshes)[0]).geometry.attributes.position.array;
  for (let i = 0; i < pos.length; i += 3) { const t = pos[i] * y.x + pos[i + 1] * y.y + pos[i + 2] * y.z; if (t < lo) lo = t; if (t > hi) hi = t; }
  shared.uSpan.value.set(lo, hi);
  const length = useLimb ? limb.length : Math.max(size.x, size.y, size.z);
  const sorted = size.toArray().sort((a, b) => a - b);
  return { R: new THREE.Matrix4().makeBasis(x, y, z), wrist: useLimb ? new THREE.Vector3(...limb.wrist) : center.clone(), center, length, width: sorted[1] };
}
/** Standard pose for a flat film: fingers assumed toward the top of the picture; wrist = narrowest part. */
function filmFrame(s, px) {
  const w = s.columns * s.spacing[0], h = s.rows * s.spacing[1];
  const tall = h >= w, nLong = tall ? s.rows : s.columns, nShort = tall ? s.columns : s.rows;
  const lo = state.wc - state.ww / 2, inv = s.first.inverted;
  const step = Math.max(1, Math.floor(nLong / 200)), widths = [];
  for (let k = 0; k < nLong; k += step) {
    let n = 0;
    for (let j = 0; j < nShort; j += 2) {
      let v = (px[tall ? k * s.columns + j : j * s.columns + k] - lo) / state.ww;
      if (inv) v = 1 - v;
      if (v > 0.12) n++;
    }
    widths.push(n);
  }
  const sm = widths.map((_, i) => { let t = 0, c = 0; for (let j = -3; j <= 3; j++) if (widths[i + j] !== undefined) { t += widths[i + j]; c++; } return t / c; });
  const a = Math.floor(sm.length * 0.12), b = Math.ceil(sm.length * 0.88);
  let best = -1, bestW = Infinity;
  for (let i = a; i < b; i++) if (sm[i] < bestW) { bestW = sm[i]; best = i; }
  const before = Math.max(...sm.slice(0, best)), after = Math.max(...sm.slice(best + 1));
  const frac = best >= 0 && bestW < 0.9 * before && bestW < 0.9 * after ? (best + 0.5) / sm.length : 0.1;
  const along = frac * (tall ? h : w) + (tall ? -8 : 8);
  const wrist = tall ? new THREE.Vector3(w / 2, along, 0) : new THREE.Vector3(along, h / 2, 0);
  // Picture rows run downward, so turn the sheet over to stand it upright facing the viewer.
  const y = tall ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(-1, 0, 0);
  const x = tall ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, -1, 0);
  const z = new THREE.Vector3().crossVectors(x, y);
  return { R: new THREE.Matrix4().makeBasis(x, y, z), wrist, center: new THREE.Vector3(w / 2, h / 2, 0), length: Math.max(w, h), width: Math.min(w, h) };
}
function updateAnatomyMatrix() {
  const f = state.frame; if (!f) return;
  const o = state.mode === 'cam' ? f.wrist : f.center;
  anatomy.matrix.copy(f.R).transpose().multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
  anatomy.matrixWorldNeedsUpdate = true;
}
function buildLayerChips() {
  const box = $('layers'); box.innerHTML = '';
  for (const [key, label] of [['bone', 'Bone'], ['muscle', 'Muscle'], ['skin', 'Skin']]) {
    if (!meshes[key]) continue;
    const b = document.createElement('button'); b.textContent = label; b.classList.toggle('on', state.show[key]);
    b.onclick = () => { state.show[key] = !state.show[key]; b.classList.toggle('on', state.show[key]); };
    box.append(b);
  }
  $('layerBtn').textContent = state.show.muscle ? 'Bones only' : 'Show muscle';
}
function resize3d() {
  const W = stage.clientWidth, H = stage.clientHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(W, H, false);
  const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
  shared.uRes.value.copy(buf);
  maskTarget.setSize(Math.max(2, buf.x >> 1), Math.max(2, buf.y >> 1));
  camera.left = -W / 2; camera.right = W / 2; camera.top = H / 2; camera.bottom = -H / 2;
  camera.updateProjectionMatrix();
}

// ---------- hand tracking → where the arm is ----------
const targetPos = new THREE.Vector3(), targetQuat = new THREE.Quaternion();
let targetScale = 1;
const sample = document.createElement('canvas');
const sampleCtx = sample.getContext('2d', { willReadFrequently: true });

/** Maps a point in the camera picture (0..1) to screen pixels, matching object-fit: cover. */
function coverMap(W, H, sw, sh) {
  const k = Math.max(W / sw, H / sh), dw = sw * k, dh = sh * k, ox = (W - dw) / 2, oy = (H - dh) / 2;
  return (p) => [ox + p.x * dw, oy + p.y * dh];
}
/** Wrist position, hand orientation and real-world scale from the 21 hand landmarks. */
function poseFromHand(hand, W, H, sw, sh) {
  const map = coverMap(W, H, sw, sh);
  const w3 = (i) => new THREE.Vector3(hand.world[i].x, -hand.world[i].y, -hand.world[i].z);
  let num = 0, den = 0;
  for (const [a, b] of [[0, 5], [0, 17], [5, 17], [0, 9], [0, 13], [5, 13]]) {
    const pa = map(hand.image[a]), pb = map(hand.image[b]), wa = hand.world[a], wb = hand.world[b];
    num += Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
    den += Math.hypot(wa.x - wb.x, wa.y - wb.y);
  }
  if (den < 0.005) return null;
  const wrist = w3(0);
  const y = w3(9).sub(wrist);                           // toward the fingers
  const unitsPerMm = y.length() / HAND_MM;              // the model's units are not exact metres
  y.normalize();
  const t = w3(5).sub(w3(17));                          // little-finger side → thumb side
  const x = t.addScaledVector(y, -t.dot(y)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  const p = map(hand.image[0]);
  return { x: p[0] - W / 2, y: H / 2 - p[1], quat: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)), pxPerMm: (num / den) * unitsPerMm };
}
/**
 * Looks at the camera picture behind the wrist for skin of the same colour as the palm and
 * returns the direction the forearm runs in (picture coordinates), or null if it is not clear.
 */
function findForearm(hand, source, sw, sh) {
  const k = 128 / Math.max(sw, sh), w = Math.max(8, Math.round(sw * k)), h = Math.max(8, Math.round(sh * k));
  if (sample.width !== w || sample.height !== h) { sample.width = w; sample.height = h; }
  sampleCtx.drawImage(source, 0, 0, w, h);
  let img;
  try { img = sampleCtx.getImageData(0, 0, w, h).data; } catch { return null; }
  const pt = (i) => [hand.image[i].x * w, hand.image[i].y * h];
  const wrist = pt(0), mid = pt(9);
  const hl = Math.hypot(mid[0] - wrist[0], mid[1] - wrist[1]);
  if (hl < 5) return null;
  const d = [(mid[0] - wrist[0]) / hl, (mid[1] - wrist[1]) / hl];
  // Reference skin colour from the middle of the palm.
  let r0 = 0, g0 = 0, b0 = 0, n0 = 0;
  for (const [a, b, c] of [[0, 5, 17], [0, 9, 9], [0, 5, 9], [0, 13, 17], [5, 17, 0]]) {
    const A = pt(a), B = pt(b), C = pt(c), x = Math.round((A[0] + B[0] + C[0]) / 3), y = Math.round((A[1] + B[1] + C[1]) / 3);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = (y * w + x) * 4; r0 += img[i]; g0 += img[i + 1]; b0 += img[i + 2]; n0++;
  }
  if (!n0) return null;
  r0 /= n0; g0 /= n0; b0 /= n0;
  const cb0 = -0.169 * r0 - 0.331 * g0 + 0.5 * b0, cr0 = 0.5 * r0 - 0.419 * g0 - 0.081 * b0, y0 = 0.299 * r0 + 0.587 * g0 + 0.114 * b0;
  const scan = (axis, band) => {
    let sx = 0, sy = 0, hits = 0, total = 0;
    const R = 2.0 * hl, x0 = Math.max(0, Math.floor(wrist[0] - R)), x1 = Math.min(w - 1, Math.ceil(wrist[0] + R));
    const yA = Math.max(0, Math.floor(wrist[1] - R)), yB = Math.min(h - 1, Math.ceil(wrist[1] + R));
    for (let yy = yA; yy <= yB; yy++) for (let xx = x0; xx <= x1; xx++) {
      const vx = xx - wrist[0], vy = yy - wrist[1], r = Math.hypot(vx, vy);
      if (r < 0.5 * hl || r > R) continue;
      const along = vx * axis[0] + vy * axis[1];
      if (along < 0.15 * hl) continue;
      if (band && Math.abs(vx * axis[1] - vy * axis[0]) > band * hl) continue;
      total++;
      const i = (yy * w + xx) * 4, rr = img[i], gg = img[i + 1], bb = img[i + 2];
      const yv = 0.299 * rr + 0.587 * gg + 0.114 * bb;
      if (Math.abs(-0.169 * rr - 0.331 * gg + 0.5 * bb - cb0) < 13 && Math.abs(0.5 * rr - 0.419 * gg - 0.081 * bb - cr0) < 13 && yv > 0.35 * y0 && yv < 1.9 * y0) { hits++; sx += vx; sy += vy; }
    }
    const len = Math.hypot(sx, sy);
    return { dir: len ? [sx / len, sy / len] : null, hits, frac: total ? hits / total : 0 };
  };
  const back = [-d[0], -d[1]];
  const first = scan(back, 0);
  // Too little skin: sleeve or arm out of view. Too much: the background is skin-coloured.
  if (!first.dir || first.hits < 25 || first.frac < 0.08 || first.frac > 0.62) return null;
  const second = scan(first.dir, 0.75);
  const f = second.dir && second.hits >= 20 ? second.dir : first.dir;
  if (f[0] * back[0] + f[1] * back[1] < 0.55) return null;   // more than ~55° from straight: not believable
  return f;
}
function applyHand(hand, source) {
  const W = stage.clientWidth, H = stage.clientHeight;
  const sw = source.videoWidth || source.width || W, sh = source.videoHeight || source.height || H;
  const r = poseFromHand(hand, W, H, sw, sh);
  if (!r) return;
  const q = r.quat;
  if (state.kind === 'image') {
    // A film has no back: keep its picture side toward the camera.
    const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    if (z.z < 0) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
  }
  // Bent wrist: swing the scan so it runs along the forearm seen in the picture, not just along the hand.
  const f = findForearm(hand, source, sw, sh);
  if (f) {
    const v = new THREE.Vector2(f[0], -f[1]);
    if (!state.forearm) state.forearm = v; else state.forearm.lerp(v, 0.3).normalize();
  } else state.forearm = null;
  if (state.forearm) {
    const a = new THREE.Vector3(0, -1, 0).applyQuaternion(q);
    const len = Math.hypot(a.x, a.y);
    if (len > 0.35) {
      const delta = Math.atan2(a.x * state.forearm.y - a.y * state.forearm.x, a.x * state.forearm.x + a.y * state.forearm.y);
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), delta));
    }
  }
  targetPos.set(r.x, r.y, 0); targetQuat.copy(q); targetScale = r.pxPerMm;
  if (!state.tracked) { pose.position.copy(targetPos); pose.quaternion.copy(targetQuat); pose.scale.setScalar(targetScale); }
  state.tracked = true; state.lastSeen = performance.now();
}
async function ensureTracker() {
  if (state.tracker || state.trackerState === 'loading') return;
  state.trackerState = 'loading';
  try {
    const { createHandTracker } = await import('./tracker.js');
    state.tracker = await createHandTracker();
    state.trackerState = 'ready';
  } catch (e) { console.error(e); state.trackerState = 'failed'; }
}
async function startCamera() {
  if (state.testSource) { state.source = state.testSource; state.camOn = true; return; }
  if (state.camOn) return;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error(window.isSecureContext ? 'no camera access in this browser' : 'the page must be opened over https');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    video.srcObject = stream;
    await video.play();
    state.source = video; state.camOn = true; state.camError = '';
  } catch (e) {
    state.camError = e.name === 'NotAllowedError' ? 'Camera access was refused. Allow the camera for this site, then reload.' : `Camera unavailable: ${e.message}`;
  }
}
function stopCamera() {
  if (video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; }
  state.camOn = false; state.tracked = false; state.fade = 0;
}
function hintText() {
  if (state.mode !== 'cam' || !state.cur) return '';
  if (!state.trackable) return state.whyNot;
  if (state.camError) return state.camError;
  if (!state.camOn) return 'Starting camera…';
  if (state.trackerState === 'loading') return 'Getting ready…';
  if (state.trackerState === 'failed') return 'Tracking could not start on this device.';
  if (!state.tracked || performance.now() - state.lastSeen > 900) return 'Point the camera at your hand and forearm';
  return '';
}

function drawAnatomy(cam) {
  renderer.setRenderTarget(null);
  renderer.clear();
  if (!state.frame) return;
  const { skin, bone, muscle, film } = meshes;
  shared.uUseMask.value = cam && skin ? 1 : 0;
  if (cam && skin) {
    // Pass 1: the arm's silhouette, soft at the edges, into the mask.
    if (bone) bone.visible = false; if (muscle) muscle.visible = false;
    skin.visible = true; skin.material = mats.mask;
    renderer.setRenderTarget(maskTarget);
    renderer.setClearColor(0x000000, 1); renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null); renderer.setClearColor(0x000000, 0);
    skin.material = mats.skin;
  }
  if (skin) skin.visible = cam || state.show.skin;
  if (bone) bone.visible = cam || state.show.bone;
  if (muscle) muscle.visible = state.show.muscle;
  if (film) film.material.opacity = shared.uFade.value;
  renderer.render(scene, camera);
}

async function tick() {
  try {
    if (state.mode === '3d' && state.frame) {
      const f = state.frame, W = stage.clientWidth, H = stage.clientHeight;
      pose.position.set(state.pan3d.x, state.pan3d.y - 10, 0);
      pose.quaternion.copy(state.orbit);
      pose.scale.setScalar(Math.min((H - 190) / f.length, W * 0.86 / Math.max(f.width, 1)) * state.zoom3d);
      shared.uFade.value = 1;
      drawAnatomy(false);
    } else if (state.mode === 'cam' && state.frame) {
      if (state.trackable && state.tracker && state.camOn && !state.loading) {
        const hand = await state.tracker.detect(state.source);
        if (hand) applyHand(hand, state.source);
      }
      const live = state.tracked && performance.now() - state.lastSeen < 400;
      state.fade += ((live ? 1 : 0) - state.fade) * (live ? 0.25 : 0.12);
      if (state.tracked) {
        pose.position.lerp(targetPos, 0.5); pose.quaternion.slerp(targetQuat, 0.4);
        pose.scale.setScalar(pose.scale.x + (targetScale - pose.scale.x) * 0.3);
      }
      shared.uFade.value = state.fade;
      if (state.fade > 0.01) drawAnatomy(true); else { renderer.setRenderTarget(null); renderer.clear(); }
    }
    const t = hintText();
    if ($('hintText').textContent !== t && t) $('hintText').textContent = t;
    $('hint').classList.toggle('off', !t);
  } catch (e) { console.error(e); }
  requestAnimationFrame(tick);
}

// ---------- modes & controls ----------
function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === mode);
  for (const c of document.querySelectorAll('#panel > div')) c.style.display = c.dataset.for === mode ? 'block' : 'none';
  $('panel').style.display = mode === 'cam' ? 'none' : 'block';
  $('layerBtn').style.display = mode === 'cam' && state.trackable && meshes.muscle ? 'block' : 'none';
  c2d.style.display = mode === '2d' ? 'block' : 'none';
  c3d.style.display = mode === '2d' ? 'none' : 'block';
  video.style.display = mode === 'cam' && !state.testSource ? 'block' : 'none';
  if (state.testSource) state.testSource.style.display = mode === 'cam' ? 'block' : 'none';
  updateAnatomyMatrix();
  if (mode === '2d') draw2d(); else resize3d();
  if (mode === 'cam') { startCamera(); if (state.trackable) ensureTracker(); }
  else stopCamera();
}
for (const b of document.querySelectorAll('#modes button')) b.onclick = () => state.cur && setMode(b.dataset.mode);
$('slice').oninput = (e) => { state.slice = +e.target.value; draw2d(); };
$('layerBtn').onclick = () => { state.show.muscle = !state.show.muscle; buildLayerChips(); };
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
for (const b of document.querySelectorAll('[data-sample]')) {
  // Hide sample buttons whose files were not deployed with the page.
  fetch(b.dataset.sample, { method: 'HEAD' }).then((r) => { if (!r.ok) b.hidden = true; }).catch(() => {});
  b.onclick = async () => {
    busy('Downloading sample…');
    try {
      const r = await fetch(b.dataset.sample);
      if (!r.ok) throw new Error(`sample not found (${r.status})`);
      await loadBuffers([{ name: b.dataset.sample, buffer: await r.arrayBuffer() }]);
    } catch (e) { busy(''); $('err').textContent = `Could not download the sample: ${e.message}`; }
  };
}

// ---------- touch gestures (Slices and 3D only; X-ray vision needs none) ----------
const pts = new Map();
let last = null;
function summary() {
  const a = [...pts.values()];
  if (a.length === 1) return { n: 1, x: a[0].x, y: a[0].y };
  const dx = a[1].x - a[0].x, dy = a[1].y - a[0].y;
  return { n: 2, x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, dist: Math.hypot(dx, dy), ang: Math.atan2(dy, dx) };
}
stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = summary(); });
const up = (e) => { pts.delete(e.pointerId); last = pts.size ? summary() : null; };
stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
stage.addEventListener('pointermove', (e) => {
  if (!pts.has(e.pointerId) || !state.cur) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const now = summary();
  if (!last || last.n !== now.n) { last = now; return; }
  const dx = now.x - last.x, dy = now.y - last.y;
  const pinch = now.n === 2 && last.dist > 0 ? now.dist / last.dist : 1;
  let twist = now.n === 2 ? now.ang - last.ang : 0;
  if (twist > Math.PI) twist -= 2 * Math.PI; else if (twist < -Math.PI) twist += 2 * Math.PI;
  last = now;
  if (state.mode === '2d') {
    const v = state.view2d;
    v.zoom = clamp(v.zoom * pinch, 0.5, 12); v.x = (v.x + dx) * (now.n === 2 ? pinch : 1); v.y = (v.y + dy) * (now.n === 2 ? pinch : 1);
    draw2d();
  } else if (state.mode === '3d') {
    if (now.n === 1) state.orbit.premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(dy * 0.008, dx * 0.008, 0, 'XYZ')));
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
  state, loadBuffers, setMode, pose, meshes, findForearm,
  useTestSource(el) {
    el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none';
    stage.insertBefore(el, c2d); state.testSource = el;
  },
};
resize3d();
tick();
