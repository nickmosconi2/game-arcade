// X-ray Viewer MVP: DICOM slices, 3D surfaces, and a camera overlay that follows the hand.
import * as THREE from './vendor/three.module.min.js';
import { parseDicom, decodeFrame, unzip, isZip, DicomError } from './dicom.js';
import { groupSeries, buildVolume, smooth, surfaceNets, otsu } from './volume.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), video = $('video'), c2d = $('c2d'), c3d = $('c3d');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

const state = {
  series: [], cur: null, mode: '2d',
  slice: 0, wc: 40, ww: 400, sliceCache: null,
  view2d: { zoom: 1, x: 0, y: 0 },
  layers: [], opacity: 1,
  anat: null,            // {kind, min, max, long, length, width}
  flip: false, mirror: false, roll: 0, slide: 0, size: 1,
  follow: true, tracked: false, lastSeen: 0,
  orbit: new THREE.Quaternion(), zoom3d: 1, pan3d: new THREE.Vector2(),
  manual: { x: 0, y: 0, angle: 0, scale: 0 },
  camOn: false, tracker: null, trackerState: 'off',
};

// ---------- loading ----------
function busy(text) { $('busy').classList.toggle('hidden', !text); if (text) $('busyText').textContent = text; }

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
    const sel = $('seriesSel');
    sel.innerHTML = '';
    state.series.forEach((s, i) => sel.add(new Option(`${s.modality} · ${s.slices.length} img · ${s.description}`.slice(0, 60), i)));
    sel.hidden = state.series.length < 2;
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
  setupWindowControls();
  $('title').textContent = s.description || 'Scan';
  const mm = s.spacingKnown ? '' : ' · size estimated';
  $('subtitle').textContent = `${s.modality} · ${s.columns}×${s.rows}${s.slices.length > 1 ? ` · ${s.slices.length} slices` : ''}${mm}`;
  $('slice').max = s.slices.length - 1; $('slice').value = state.slice;
  $('sliceRow').style.display = s.slices.length > 1 ? '' : 'none';

  // 3D content
  clearAnatomy();
  state.flip = false; state.mirror = false; state.roll = 0; state.slide = 0; state.size = 1;
  state.orbit.identity(); state.zoom3d = 1; state.pan3d.set(0, 0); state.manual.scale = 0; state.tracked = false;
  if (s.isVolume) {
    let vol = await buildVolume(s, async (p) => { busy(`Building 3D… ${Math.round(p * 100)}%`); await nextFrame(); });
    busy('Building surfaces…'); await nextFrame();
    vol = smooth(vol);
    const defs = isCT
      ? [{ name: 'Bone', iso: 250, color: 0xf3ecdc, opacity: 1, on: true },
         { name: 'Muscle', iso: 10, color: 0xc0453c, opacity: 0.42, on: true },
         { name: 'Skin', iso: -300, color: 0xe2b594, opacity: 0.22, on: false }]
      : (() => { const t = otsu(vol.data); return [{ name: 'Surface', iso: t, color: 0xe2b594, opacity: 0.55, on: true }]; })();
    for (const d of defs) { addSurface(vol, d); await nextFrame(); }
    finishAnatomy('volume');
  } else {
    addImagePlane(s, px);
    finishAnatomy('image');
  }
  syncControls();
  setMode(state.mode);
  busy('');
}

// ---------- 2D slice view ----------
const off = document.createElement('canvas');
function setupWindowControls() {
  const s = state.cur, [lo, hi] = s.range, span = hi - lo;
  $('wc').min = lo; $('wc').max = hi; $('wc').step = span / 500; $('wc').value = state.wc;
  $('ww').min = span / 500; $('ww').max = span * 1.2; $('ww').step = span / 500; $('ww').value = state.ww;
  const presets = s.modality === 'CT'
    ? [['Bone', 300, 1500], ['Soft tissue', 40, 400], ['Lung', -600, 1500]]
    : [['Auto', (lo + hi) / 2, span], ['Bright', lo + span * 0.3, span * 0.6], ['Contrast', lo + span * 0.5, span * 0.5]];
  const box = $('presets'); box.innerHTML = '';
  for (const [name, c, w] of presets) {
    const b = document.createElement('button'); b.textContent = name;
    b.onclick = () => { state.wc = c; state.ww = w; $('wc').value = c; $('ww').value = w; windowChanged(true); };
    box.append(b);
  }
}
function windowChanged(final) {
  $('wcOut').textContent = Math.round(state.wc); $('wwOut').textContent = Math.round(state.ww);
  draw2d();
  if (final && state.anat && state.anat.kind === 'image') refreshImageTexture();
}
async function getSlice() {
  const s = state.cur, i = state.slice;
  if (state.sliceCache && state.sliceCache.i === i && state.sliceCache.s === s) return state.sliceCache.px;
  const px = await decodeFrame(s.slices[i].file, s.slices[i].frame);
  state.sliceCache = { i, s, px };
  return px;
}
function grayscale(px, s, out, alphaFromBrightness) {
  const lo = state.wc - state.ww / 2, k = 255 / state.ww, inv = s.first.inverted;
  for (let i = 0, j = 0; i < px.length; i++, j += 4) {
    let v = (px[i] - lo) * k;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    if (inv) v = 255 - v;
    if (alphaFromBrightness) {
      // Camera overlay: dark film is see-through, dense bone is solid.
      out[j] = 200 + v * 0.2; out[j + 1] = 225 + v * 0.11; out[j + 2] = 255; out[j + 3] = Math.pow(v / 255, 1.3) * 255;
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
    const fit = Math.min(W / wmm, (H - 190) / hmm) * state.view2d.zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, W / 2 + state.view2d.x - wmm * fit / 2, (H - 130) / 2 + state.view2d.y - hmm * fit / 2, wmm * fit, hmm * fit);
    $('sliceOut').textContent = `${state.slice + 1}/${s.slices.length}`;
  } finally {
    drawing = false;
    if (drawAgain) { drawAgain = false; draw2d(); }
  }
}

// ---------- 3D scene ----------
const renderer = new THREE.WebGLRenderer({ canvas: c3d, alpha: true, antialias: true });
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20000);
camera.position.z = 10000;
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(0.4, 0.6, 1); scene.add(sun);
const pose = new THREE.Group(), adjust = new THREE.Group(), anatomy = new THREE.Group();
anatomy.matrixAutoUpdate = false;
scene.add(pose); pose.add(adjust); adjust.add(anatomy);
let imageTexture = null, imageCanvas = null, imageSource = null;

function clearAnatomy() {
  for (const c of [...anatomy.children]) { anatomy.remove(c); c.geometry.dispose(); c.material.dispose(); }
  if (imageTexture) { imageTexture.dispose(); imageTexture = null; }
  state.layers = []; state.anat = null;
}
function addSurface(vol, def) {
  const m = surfaceNets(vol, def.iso);
  if (m.indices.length < 12) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
  geo.computeVertexNormals(); geo.computeBoundingBox();
  const solid = def.opacity >= 1;
  const mat = new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.65, metalness: 0, transparent: true, opacity: def.opacity, depthWrite: solid, side: solid ? THREE.FrontSide : THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = solid ? 0 : def.opacity > 0.3 ? 1 : 2;
  mesh.visible = def.on;
  anatomy.add(mesh);
  state.layers.push({ ...def, mesh });
}
function addImagePlane(s, px) {
  const w = s.columns * s.spacing[0], h = s.rows * s.spacing[1];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, w, 0, 0, w, h, 0, 0, h, 0]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 2));
  geo.setIndex([0, 2, 1, 0, 3, 2]); geo.computeBoundingBox();
  // Texture is capped at 1024 px on the long side to keep phones comfortable.
  const k = Math.min(1, 1024 / Math.max(s.columns, s.rows));
  imageCanvas = document.createElement('canvas');
  imageCanvas.width = Math.round(s.columns * k); imageCanvas.height = Math.round(s.rows * k);
  imageSource = { s, px };
  imageTexture = new THREE.CanvasTexture(imageCanvas);
  imageTexture.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: imageTexture, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  anatomy.add(mesh);
  state.layers.push({ name: 'X-ray', opacity: 1, on: true, mesh });
  refreshImageTexture();
}
function refreshImageTexture() {
  if (!imageSource) return;
  const { s, px } = imageSource;
  const full = document.createElement('canvas'); full.width = s.columns; full.height = s.rows;
  const fctx = full.getContext('2d'), img = fctx.createImageData(s.columns, s.rows);
  grayscale(px, s, img.data, true);
  fctx.putImageData(img, 0, 0);
  const ctx = imageCanvas.getContext('2d');
  ctx.clearRect(0, 0, imageCanvas.width, imageCanvas.height);
  ctx.drawImage(full, 0, 0, imageCanvas.width, imageCanvas.height);
  imageTexture.needsUpdate = true;
}
function finishAnatomy(kind) {
  if (!state.layers.length) return;
  const all = new THREE.Box3();
  for (const l of state.layers) all.union(l.mesh.geometry.boundingBox);
  const size = all.getSize(new THREE.Vector3()).toArray();
  let long = size.indexOf(Math.max(...size));
  if (kind === 'image') long = size[0] > size[1] ? 0 : 1;
  const cross = size.filter((_, i) => i !== long);
  state.anat = { kind, min: all.min.toArray(), max: all.max.toArray(), long, length: size[long], width: Math.max(...cross) };
  updateAnatomyMatrix();
  buildLayerChips();
}
/** Places the scan in a standard frame: long axis along Y; in camera mode the wrist end sits at the origin. */
function updateAnatomyMatrix() {
  const a = state.anat; if (!a) return;
  const cam = state.mode === 'cam';
  const c = [0, 1, 2].map((i) => (a.min[i] + a.max[i]) / 2);
  const anchor = c.slice();
  const R = new THREE.Matrix4();
  if (a.kind === 'image') {
    // Image rows run top-to-bottom; turn the sheet over so it reads upright and faces the camera.
    if (a.long === 1) {
      if (cam) anchor[1] = state.flip ? a.max[1] : a.min[1];
      R.set(state.flip ? -1 : 1, 0, 0, 0, 0, state.flip ? 1 : -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1);
    } else {
      if (cam) anchor[0] = state.flip ? a.min[0] : a.max[0];
      const k = state.flip ? -1 : 1;
      R.set(0, k, 0, 0, k, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1);
    }
  } else {
    // Rotate so the long axis becomes "z", then stand it up along Y.
    const perm = a.long === 0 ? [1, 2, 0] : a.long === 1 ? [2, 0, 1] : [0, 1, 2]; // rows: which source axis feeds x', y', z'
    const P = new THREE.Matrix4(); const e = P.elements; e.fill(0); e[15] = 1;
    perm.forEach((srcAxis, row) => { e[srcAxis * 4 + row] = 1; });
    const U = new THREE.Matrix4();
    if (state.flip) U.set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
    else U.set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
    R.multiplyMatrices(U, P);
    if (cam) anchor[a.long] = state.flip ? a.min[a.long] : a.max[a.long];
  }
  anatomy.matrix.copy(R).multiply(new THREE.Matrix4().makeTranslation(-anchor[0], -anchor[1], -anchor[2]));
  anatomy.matrixWorldNeedsUpdate = true;
}
function buildLayerChips() {
  const box = $('layers'); box.innerHTML = '';
  for (const l of state.layers) {
    const b = document.createElement('button'); b.textContent = l.name; b.classList.toggle('on', l.on);
    b.onclick = () => { l.on = !l.on; l.mesh.visible = l.on; b.classList.toggle('on', l.on); };
    box.append(b);
  }
  applyOpacity();
}
function applyOpacity() {
  for (const l of state.layers) {
    const o = l.opacity * state.opacity;
    l.mesh.material.opacity = o;
    if (l.mesh.material.isMeshStandardMaterial) l.mesh.material.depthWrite = o > 0.95;
  }
  $('opacityOut').textContent = `${Math.round(state.opacity * 100)}%`;
}

function resize3d() {
  const W = stage.clientWidth, H = stage.clientHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(W, H, false);
  camera.left = -W / 2; camera.right = W / 2; camera.top = H / 2; camera.bottom = -H / 2;
  camera.updateProjectionMatrix();
}
const usableHeight = () => stage.clientHeight - 190;
function fitScale() {
  const a = state.anat; if (!a) return 1;
  return Math.min(usableHeight() * 0.92 / a.length, stage.clientWidth * 0.9 / Math.max(a.width, 1));
}

// ---------- hand tracking → overlay pose ----------
const targetPos = new THREE.Vector3(), targetQuat = new THREE.Quaternion();
let targetScale = 1;
/** Convert a MediaPipe hand (image + world landmarks) into where the wrist is, how the hand is turned, and px per mm. */
export function poseFromHand(hand, W, H, vw, vh) {
  const cover = Math.max(W / vw, H / vh), dw = vw * cover, dh = vh * cover, ox = (W - dw) / 2, oy = (H - dh) / 2;
  const px = (i) => [ox + hand.image[i].x * dw, oy + hand.image[i].y * dh];
  const w3 = (i) => new THREE.Vector3(hand.world[i].x, -hand.world[i].y, -hand.world[i].z);
  // Scale: compare on-screen distances with the same distances in metres.
  let num = 0, den = 0;
  for (const [a, b] of [[0, 5], [0, 17], [5, 17], [0, 9], [0, 13], [5, 13]]) {
    const pa = px(a), pb = px(b), wa = hand.world[a], wb = hand.world[b];
    num += Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
    den += Math.hypot(wa.x - wb.x, wa.y - wb.y);
  }
  if (den < 0.01) return null;
  const wrist = w3(0);
  const y = w3(9).sub(wrist).normalize();              // toward the fingers
  const t = w3(5).sub(w3(17));                          // pinky side → thumb side
  const x = t.sub(y.clone().multiplyScalar(t.dot(y))).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  const p = px(0);
  return { x: p[0] - W / 2, y: H / 2 - p[1], quat: q, pxPerMm: num / den / 1000 };
}
function applyHand(hand) {
  const W = stage.clientWidth, H = stage.clientHeight;
  const r = poseFromHand(hand, W, H, video.videoWidth || W, video.videoHeight || H);
  if (!r) return;
  targetPos.set(r.x, r.y, 0); targetQuat.copy(r.quat); targetScale = r.pxPerMm;
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
  if (state.camOn) return;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error(window.isSecureContext ? 'no camera access in this browser' : 'the page must be opened over https');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    video.srcObject = stream;
    await video.play();
    state.camOn = true; state.camError = '';
  } catch (e) {
    state.camError = e.name === 'NotAllowedError' ? 'Camera permission was refused, or this page is embedded where the camera is blocked.' : `Camera unavailable: ${e.message}`;
  }
}
function statusText() {
  if (state.mode !== 'cam') return '';
  if (state.camError) return `${state.camError} You can still position the overlay by hand.`;
  if (!state.camOn) return 'Starting camera…';
  if (!state.follow) return 'Drag to move · pinch to resize · twist with two fingers';
  if (state.trackerState === 'loading') return 'Loading hand tracking…';
  if (state.trackerState === 'failed') return 'Hand tracking could not load. Turn off Follow to place it by hand.';
  if (!state.tracked || performance.now() - state.lastSeen > 1200) return 'Show your hand and forearm to the camera';
  return '';
}

function tick() {
  requestAnimationFrame(tick);
  if (state.mode === '2d' || !state.anat) return;
  const W = stage.clientWidth, H = stage.clientHeight;
  if (state.mode === '3d') {
    pose.position.set(state.pan3d.x, 65 + state.pan3d.y, 0);
    pose.quaternion.copy(state.orbit);
    pose.scale.setScalar(fitScale() * state.zoom3d);
    adjust.position.set(0, 0, 0); adjust.rotation.set(0, 0, 0); adjust.scale.set(1, 1, 1);
  } else {
    if (state.follow && state.tracker && state.camOn) {
      const hand = state.tracker.detect(video);
      if (hand) applyHand(hand);
    }
    if (state.follow && state.tracked) {
      pose.position.lerp(targetPos, 0.4); pose.quaternion.slerp(targetQuat, 0.35);
      pose.scale.setScalar(pose.scale.x + (targetScale - pose.scale.x) * 0.25);
    } else {
      const m = state.manual;
      if (!m.scale) { m.scale = fitScale() * 0.9; m.x = 0; m.y = 65 + state.anat.length * m.scale / 2; m.angle = 0; }
      pose.position.set(m.x, m.y, 0);
      pose.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), m.angle);
      pose.scale.setScalar(m.scale);
    }
    adjust.rotation.set(0, THREE.MathUtils.degToRad(state.roll), 0);
    adjust.position.set(0, state.slide, 0);
    adjust.scale.set(state.mirror ? -state.size : state.size, state.size, state.size);
  }
  const t = statusText();
  if ($('statusText').textContent !== t) $('statusText').textContent = t;
  renderer.render(scene, camera);
}

// ---------- modes & controls ----------
function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.mode === mode);
  for (const c of document.querySelectorAll('.ctl')) c.style.display = c.dataset.for.split(' ').includes(mode) ? 'block' : 'none';
  c2d.style.display = mode === '2d' ? 'block' : 'none';
  c3d.style.display = mode === '2d' ? 'none' : 'block';
  video.style.display = mode === 'cam' ? 'block' : 'none';
  $('statusText').textContent = '';
  updateAnatomyMatrix();
  if (mode === '2d') draw2d(); else resize3d();
  if (mode === 'cam') { startCamera(); if (state.follow) ensureTracker(); }
  else if (state.camOn) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; state.camOn = false; state.tracked = false; }
}
function syncControls() {
  $('roll').value = state.roll; $('rollOut').textContent = `${state.roll}°`;
  $('slide').value = state.slide; $('slideOut').textContent = `${state.slide} mm`;
  $('size').value = state.size * 100; $('sizeOut').textContent = `${Math.round(state.size * 100)}%`;
  $('opacity').value = state.opacity * 100;
  $('followBtn').classList.toggle('on', state.follow);
  $('flipBtn').classList.toggle('on', state.flip);
  $('mirrorBtn').classList.toggle('on', state.mirror);
  $('wcOut').textContent = Math.round(state.wc); $('wwOut').textContent = Math.round(state.ww);
  applyOpacity();
}
for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => state.cur && setMode(b.dataset.mode);
$('slice').oninput = (e) => { state.slice = +e.target.value; draw2d(); };
$('wc').oninput = (e) => { state.wc = +e.target.value; windowChanged(false); };
$('ww').oninput = (e) => { state.ww = +e.target.value; windowChanged(false); };
$('wc').onchange = $('ww').onchange = () => windowChanged(true);
$('opacity').oninput = (e) => { state.opacity = e.target.value / 100; applyOpacity(); };
$('roll').oninput = (e) => { state.roll = +e.target.value; syncControls(); };
$('slide').oninput = (e) => { state.slide = +e.target.value; syncControls(); };
$('size').oninput = (e) => { state.size = e.target.value / 100; syncControls(); };
$('followBtn').onclick = () => {
  state.follow = !state.follow;
  if (state.follow) ensureTracker();
  else if (state.tracked) {
    // Keep the overlay where tracking left it so it can be nudged by hand.
    const e = new THREE.Euler().setFromQuaternion(pose.quaternion, 'ZXY');
    Object.assign(state.manual, { x: pose.position.x, y: pose.position.y, angle: e.z, scale: pose.scale.x });
  }
  state.tracked = false; syncControls();
};
$('flipBtn').onclick = () => { state.flip = !state.flip; updateAnatomyMatrix(); syncControls(); };
$('mirrorBtn').onclick = () => { state.mirror = !state.mirror; syncControls(); };
$('resetBtn').onclick = () => { state.roll = 0; state.slide = 0; state.size = 1; state.manual.scale = 0; state.mirror = false; syncControls(); };
$('panelToggle').onclick = () => { const closed = $('panel').classList.toggle('closed'); $('panelToggle').textContent = closed ? '▴ controls' : '▾ controls'; };
$('seriesSel').onchange = (e) => openSeries(+e.target.value);
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
  b.onclick = async () => {
    busy('Downloading sample…');
    try {
      const r = await fetch(b.dataset.sample);
      if (!r.ok) throw new Error(`sample not found (${r.status})`);
      await loadBuffers([{ name: b.dataset.sample, buffer: await r.arrayBuffer() }]);
      // The demo arm includes a hand, so start with the wrist (not the knuckles) on the tracked wrist.
      if (b.dataset.slide) { state.slide = +b.dataset.slide; syncControls(); }
    } catch (e) { busy(''); $('err').textContent = `Could not download the sample: ${e.message}`; }
  };
}

// Hide sample buttons whose files were not deployed with the page.
for (const b of document.querySelectorAll('[data-sample]')) {
  fetch(b.dataset.sample, { method: 'HEAD' }).then((r) => { if (!r.ok) b.hidden = true; }).catch(() => {});
}

// ---------- touch gestures ----------
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
    if (now.n === 1) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(dy * 0.008, dx * 0.008, 0, 'XYZ'));
      state.orbit.premultiply(q);
    } else {
      state.zoom3d = clamp(state.zoom3d * pinch, 0.3, 12); state.pan3d.x += dx; state.pan3d.y -= dy;
      state.orbit.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -twist));
    }
  } else if (state.follow && state.tracked) {
    if (now.n === 1) {
      state.roll = Math.round(clamp(state.roll + dx * 0.6, -180, 180));
      state.slide = Math.round(clamp(state.slide - dy / Math.max(pose.scale.x, 0.01), -200, 200));
    } else state.size = clamp(state.size * pinch, 0.5, 2);
    syncControls();
  } else {
    const m = state.manual;
    m.x += dx; m.y -= dy;
    if (now.n === 2) { m.scale = clamp(m.scale * pinch, 0.05, 50); m.angle -= twist; }
  }
});
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const k = Math.exp(-e.deltaY * 0.0015);
  if (state.mode === '2d') { state.view2d.zoom = clamp(state.view2d.zoom * k, 0.5, 12); draw2d(); }
  else if (state.mode === '3d') state.zoom3d = clamp(state.zoom3d * k, 0.3, 12);
  else if (state.follow && state.tracked) { state.size = clamp(state.size * k, 0.5, 2); syncControls(); }
  else state.manual.scale = clamp(state.manual.scale * k, 0.05, 50);
}, { passive: false });
window.addEventListener('resize', () => { if (state.mode === '2d') draw2d(); else resize3d(); });

// Test hooks: lets automated checks drive the app without a camera.
window.__xrv = { state, loadBuffers, setMode, applyHand, pose, anatomy, THREE };
resize3d();
tick();
