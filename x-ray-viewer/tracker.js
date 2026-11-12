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
