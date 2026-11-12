// Hand and body tracking (MediaPipe Tasks 0.10.14; code, wasm and models bundled in vendor/mediapipe).
const LIB = new URL('./vendor/mediapipe', import.meta.url).href;
let visionP = null, filesP = null;
async function vision() {
  if (!visionP) visionP = import('./vendor/mediapipe/vision_bundle.mjs');
  const v = await visionP;
  if (!filesP) filesP = v.FilesetResolver.forVisionTasks(`${LIB}/wasm`);
  return { v, files: await filesP };
}
async function create(make) {
  try { return { task: await make('GPU'), cpu: false }; } catch { return { task: await make('CPU'), cpu: true }; }
}

export async function createHandTracker() {
  const { v, files } = await vision();
  const make = (delegate) => v.HandLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: `${LIB}/hand_landmarker.task`, delegate },
    runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let { task, cpu } = await create(make);
  let lastStamp = 0;
  return {
    /** Returns [{image, world, label, score}] (possibly empty). */
    async detect(source) {
      const stamp = Math.max(lastStamp + 1, performance.now()); lastStamp = stamp;
      let r;
      try { r = task.detectForVideo(source, stamp); }
      catch (e) { if (cpu) throw e; task = await make('CPU'); cpu = true; return []; }
      return (r.landmarks || []).map((lm, i) => {
        const h = r.handednesses && r.handednesses[i] && r.handednesses[i][0];
        return { image: lm, world: r.worldLandmarks[i], label: h ? h.categoryName : '', score: h ? h.score : 0 };
      });
    },
  };
}

export async function createPoseTracker() {
  const { v, files } = await vision();
  const make = (delegate) => v.PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: `${LIB}/pose_landmarker_lite.task`, delegate },
    runningMode: 'VIDEO', numPoses: 1, outputSegmentationMasks: true,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let { task, cpu } = await create(make);
  let lastStamp = 0;
  return {
    /** Returns {image, world, vis, mask: {data, w, h}} or null. */
    async detect(source) {
      const stamp = Math.max(lastStamp + 1, performance.now()); lastStamp = stamp;
      let r;
      try { r = task.detectForVideo(source, stamp); }
      catch (e) { if (cpu) throw e; task = await make('CPU'); cpu = true; return null; }
      let mask = null;
      if (r.segmentationMasks && r.segmentationMasks[0]) {
        const m = r.segmentationMasks[0];
        mask = { data: m.getAsFloat32Array().slice(), w: m.width, h: m.height };
        m.close();
      }
      if (!r.landmarks || !r.landmarks.length) return null;
      return { image: r.landmarks[0], world: r.worldLandmarks[0], vis: r.landmarks[0].map((p) => p.visibility ?? 1), mask };
    },
  };
}

// ---------- MoveNet (TensorFlow.js): finds knees, ankles, elbows and hips without a face in view ----------
// MediaPipe's body tracker starts from the face, so a leg on its own is never found. MoveNet looks for
// each joint directly; it is loaded only when needed (about 13 MB).
const TFJS = new URL('./vendor/tfjs', import.meta.url).href, MOVENET = new URL('./vendor/movenet/model.json', import.meta.url).href;
const loadScript = (src) => new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error(`could not load ${src}`)); document.head.append(s); });
// MoveNet's 17 joints, in the 33-point MediaPipe numbering the rig uses.
const MOVE_TO_MP = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

export async function createMoveNet() {
  if (!window.tf) { await loadScript(`${TFJS}/tf-core.min.js`); await loadScript(`${TFJS}/tf-backend-webgl.min.js`); await loadScript(`${TFJS}/tf-converter.min.js`); }
  const tf = window.tf;
  try { await tf.setBackend('webgl'); } catch { await tf.setBackend('cpu'); }
  await tf.ready();
  const model = await tf.loadGraphModel(MOVENET);
  const S = 256, pad = document.createElement('canvas'); pad.width = pad.height = S;
  const px = pad.getContext('2d', { willReadFrequently: true });
  return {
    /** Returns {image: 33 points {x, y} (0..1 of the source), vis: 33 scores} or null. */
    async detect(source) {
      const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height, k = S / Math.max(sw, sh);
      const dw = sw * k, dh = sh * k, ox = (S - dw) / 2, oy = (S - dh) / 2;
      px.fillStyle = '#6e6e6e'; px.fillRect(0, 0, S, S); px.drawImage(source, ox, oy, dw, dh);
      const out = tf.tidy(() => model.execute(tf.expandDims(tf.browser.fromPixels(pad), 0)));
      const a = await out.data(); out.dispose();
      const image = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 })), vis = new Array(33).fill(0);
      let any = false;
      MOVE_TO_MP.forEach((m, i) => {
        const y = a[i * 3], x = a[i * 3 + 1], s = a[i * 3 + 2];
        image[m] = { x: (x * S - ox) / dw, y: (y * S - oy) / dh }; vis[m] = s; if (s > 0.3) any = true;
      });
      return any ? { image, vis } : null;
    },
  };
}
