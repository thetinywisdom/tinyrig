// Body tracking with MediaPipe Pose Landmarker. The model and its engine are
// files inside the app (public/models, public/mediapipe): nothing is uploaded.
import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark } from './mapping';

let loading: Promise<PoseLandmarker> | null = null;

function landmarker(): Promise<PoseLandmarker> {
  loading ??= (async () => {
    const vision = await import('@mediapipe/tasks-vision');
    const files = await vision.FilesetResolver.forVisionTasks(new URL('mediapipe', document.baseURI).href);
    return vision.PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: new URL('models/pose_landmarker_lite.task', document.baseURI).href },
      runningMode: 'IMAGE', numPoses: 1,
    });
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

/** Find one person in a picture. Returns their body points in image pixels, or null if nobody was found. */
export async function detectPose(image: HTMLImageElement | HTMLCanvasElement, width: number, height: number): Promise<Landmark[] | null> {
  const found = (await landmarker()).detect(image).landmarks[0];
  return found ? found.map((p) => ({ x: p.x * width, y: p.y * height, z: p.z, visibility: p.visibility ?? 1 })) : null;
}
