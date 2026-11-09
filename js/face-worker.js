// Detector de rosto (MediaPipe) fora da thread principal: a detecção não trava a tela.
// Recebe um ImageBitmap já recortado/reduzido e devolve as caixas dos rostos.

// O MediaPipe carrega o loader do WASM com importScripts; em module worker isso falha e ele
// usa self.import(url). O loader é um script clássico que define `var ModuleFactory`:
// eval indireto (escopo global) para a variável virar global, como num <script>.
self.import = async (url) => {
  (0, eval)(await (await fetch(url)).text());
};

let mp = null;
let engine = '';
const ready = (async () => {
  const { FaceDetector } = await import('../vendor/mediapipe/vision_bundle.mjs');
  const base = new URL('../vendor/mediapipe/', import.meta.url).href;
  const fileset = {
    wasmLoaderPath: base + 'wasm/vision_wasm_internal.js',
    wasmBinaryPath: base + 'wasm/vision_wasm_internal.wasm',
  };
  const create = (delegate) => FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: base + 'blaze_face_short_range.tflite', delegate },
    runningMode: 'VIDEO',
    minDetectionConfidence: 0.5,
  });
  try {
    mp = await create('GPU');
    engine = 'GPU';
  } catch {
    mp = await create('CPU');
    engine = 'CPU';
  }
})();

let lastTs = 0;
self.onmessage = async ({ data }) => {
  try {
    await ready;
    if (data.type === 'init') {
      self.postMessage({ id: data.id, engine });
      return;
    }
    const t0 = performance.now();
    lastTs = Math.max(lastTs + 1, t0); // o modo VIDEO exige tempos crescentes
    const r = mp.detectForVideo(data.bitmap, lastTs);
    self.postMessage({
      id: data.id,
      ms: performance.now() - t0,
      faces: r.detections.map((d) => {
        const b = d.boundingBox;
        return { x: b.originX, y: b.originY, width: b.width, height: b.height };
      }),
    });
  } catch (e) {
    self.postMessage({ id: data.id, error: String(e?.message || e) });
  } finally {
    data.bitmap?.close();
  }
};
