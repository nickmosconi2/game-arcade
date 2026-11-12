// Hand tracking for the camera view. Loaded only when the camera starts.
// Uses MediaPipe Hand Landmarker 0.10.14 (code and wasm are bundled in vendor/mediapipe;
// only the small model file is fetched from Google's public model store on first use).
const LIB = new URL('./vendor/mediapipe', import.meta.url).href;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export async function createHandTracker() {
  const vision = await import('./vendor/mediapipe/vision_bundle.mjs');
  const files = await vision.FilesetResolver.forVisionTasks(`${LIB}/wasm`);
  const make = (delegate) => vision.HandLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO', numHands: 1,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let landmarker;
  try { landmarker = await make('GPU'); } catch { landmarker = await make('CPU'); }
  let lastTime = -1;
  return {
    /** Returns {image: 21 points in 0..1 video coords, world: 21 points in metres} or null. */
    detect(video) {
      if (video.readyState < 2 || video.currentTime === lastTime) return undefined; // no new frame
      lastTime = video.currentTime;
      const r = landmarker.detectForVideo(video, performance.now());
      if (!r.landmarks || !r.landmarks.length) return null;
      return { image: r.landmarks[0], world: r.worldLandmarks[0] };
    },
  };
}
