// Hand tracking for the camera view. Loaded only when the camera starts.
// MediaPipe Hand Landmarker 0.10.14; code, wasm and model are all bundled in vendor/mediapipe.
const LIB = new URL('./vendor/mediapipe', import.meta.url).href;

export async function createHandTracker() {
  const vision = await import('./vendor/mediapipe/vision_bundle.mjs');
  const files = await vision.FilesetResolver.forVisionTasks(`${LIB}/wasm`);
  const make = (delegate) => vision.HandLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: `${LIB}/hand_landmarker.task`, delegate },
    runningMode: 'VIDEO', numHands: 1,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let landmarker, onCpu = false;
  try { landmarker = await make('GPU'); } catch { landmarker = await make('CPU'); onCpu = true; }
  let lastTime = -1, lastStamp = 0;
  return {
    /** Returns {image: 21 points in 0..1 coords, world: 21 points} | null (no hand) | undefined (no new frame). */
    async detect(source) {
      if (source.tagName === 'VIDEO') {
        if (source.readyState < 2 || source.currentTime === lastTime) return undefined;
        lastTime = source.currentTime;
      }
      const stamp = Math.max(lastStamp + 1, performance.now());
      lastStamp = stamp;
      let r;
      try { r = landmarker.detectForVideo(source, stamp); }
      catch (e) {
        if (onCpu) throw e;
        landmarker = await make('CPU'); onCpu = true; // graphics path failed on this device
        return undefined;
      }
      if (!r.landmarks || !r.landmarks.length) return null;
      return { image: r.landmarks[0], world: r.worldLandmarks[0] };
    },
  };
}
