// Vertical inteligente: recorta 9:16 do vídeo da câmera num canvas e acompanha o rosto.
// Detecção a ~8 fps; o recorte anda a cada quadro com suavização, zona morta e
// velocidade máxima, para não "tremer". O canvas é o que aparece na tela e o que é gravado.

const DETECT_EVERY_MS = 125;
const DET_SIZE = 256;        // lado da janela enviada ao detector
const VENDOR_CACHE = 'teleprompter-vendor-mediapipe-0.10.34'; // igual ao sw.js
const DEAD_ZONE = 0.05;      // fração da largura da fonte: dentro disso não começa a mexer
const SETTLE = 0.012;        // já andando: para quando chega tão perto do alvo
const SMOOTH_TAU = 0.35;     // s — quanto maior, mais suave
const MAX_SPEED = 0.6;       // fração da largura da fonte por segundo
const LOST_AFTER_MS = 1500;  // sem rosto por esse tempo → volta devagar ao centro

let detectorPromise = null;

/** Detector de rosto: nativo (Shape Detection API) se existir; senão MediaPipe local. */
function loadDetector() {
  detectorPromise ??= (async () => {
    if ('FaceDetector' in window) {
      try {
        const native = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 3 });
        return {
          async detect(video) {
            const faces = await native.detect(video);
            return faces.map((f) => f.boundingBox);
          },
        };
      } catch { /* cai no MediaPipe */ }
    }
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
    const mp = await create('GPU').catch(() => create('CPU'));
    // Garante tudo no cache offline (na 1ª visita o import pode sair antes do service
    // worker assumir a página). O que já está em cache é servido por ele, sem novo download.
    globalThis.caches?.open(VENDOR_CACHE)
      .then((c) => c.addAll(['vision_bundle.mjs', 'wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm', 'blaze_face_short_range.tflite'].map((f) => base + f)))
      .catch(() => {});
    return {
      async detect(video) {
        const r = mp.detectForVideo(video, performance.now());
        return r.detections.map((d) => {
          const b = d.boundingBox;
          return { x: b.originX, y: b.originY, width: b.width, height: b.height };
        });
      },
    };
  })();
  detectorPromise.catch(() => { detectorPromise = null; });
  return detectorPromise;
}

/** Retângulo 9:16 máximo dentro da fonte. */
export function cropSize(srcW, srcH) {
  let h = srcH;
  let w = Math.round((h * 9) / 16);
  if (w > srcW) { w = srcW; h = Math.round((w * 16) / 9); }
  return { w: w & ~1, h: h & ~1 };
}

/**
 * Próximo centro do recorte (puro, testável). Histerese: só começa a andar quando o alvo
 * sai da zona morta e, uma vez andando, vai até centralizar (SETTLE).
 */
export function stepCenter(cur, target, dt, srcW, moving) {
  const diff = target - cur;
  if (!moving && Math.abs(diff) < DEAD_ZONE * srcW) return { center: cur, moving: false };
  if (moving && Math.abs(diff) < SETTLE * srcW) return { center: cur, moving: false };
  let step = diff * (1 - Math.exp(-dt / SMOOTH_TAU));
  const max = MAX_SPEED * srcW * dt;
  step = Math.max(-max, Math.min(max, step));
  return { center: cur + step, moving: true };
}

export function createReframe(video, canvas, { follow = true, onStatus = () => {}, onResize = () => {} } = {}) {
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  let running = true;
  let detector = null;
  let busy = false;
  let lastDetect = 0;
  let lastFaceAt = 0;
  let lastT = 0;
  let center = null;
  let target = null;
  let scan = 0;
  let moving = false;
  const detCanvas = document.createElement('canvas');
  detCanvas.width = detCanvas.height = DET_SIZE;
  const detCtx = detCanvas.getContext('2d', { willReadFrequently: true });
  const state = { center: 0, target: 0, faces: 0, mode: 'center', detections: 0, detectMs: 0 };

  if (follow) {
    onStatus('loading');
    loadDetector()
      .then((d) => { detector = d; onStatus('ready'); })
      .catch(() => onStatus('error'));
  }

  function frame(now) {
    if (!running) return;
    const sw = video.videoWidth;
    const sh = video.videoHeight;
    if (sw && sh) {
      const { w, h } = cropSize(sw, sh);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        onResize();
      }
      center ??= sw / 2;
      target ??= sw / 2;
      const dt = lastT ? Math.min((now - lastT) / 1000, 0.1) : 0;
      lastT = now;

      if (detector && !busy && now - lastDetect > DETECT_EVERY_MS) {
        lastDetect = now;
        busy = true;
        // O modelo reduz a entrada a 128 px: no quadro 16:9 inteiro o rosto some.
        // Detecta numa janela quadrada (altura do quadro) onde o rosto estava; perdido,
        // varre esquerda/centro/direita.
        const side = Math.min(sw, sh);
        const found = performance.now() - lastFaceAt < 600;
        const cx = found ? target : [side / 2, sw / 2, sw - side / 2][scan++ % 3];
        const rx = Math.round(Math.max(0, Math.min(sw - side, cx - side / 2)));
        const ry = Math.round((sh - side) / 2);
        detCtx.drawImage(video, rx, ry, side, side, 0, 0, DET_SIZE, DET_SIZE);
        const k = side / DET_SIZE;
        const t0 = performance.now();
        detector.detect(detCanvas).then((faces) => {
          state.detections++;
          state.detectMs = Math.round(performance.now() - t0);
          if (faces.length) {
            // Maior rosto = quem está lendo.
            const f = faces.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
            target = rx + (f.x + f.width / 2) * k;
            lastFaceAt = performance.now();
          }
          state.faces = faces.length;
        }).catch(() => {}).finally(() => { busy = false; });
      }
      if (!detector || performance.now() - lastFaceAt > LOST_AFTER_MS) target = sw / 2;

      ({ center, moving } = stepCenter(center, target, dt, sw, moving));
      const half = w / 2;
      center = Math.max(half, Math.min(sw - half, center));
      ctx.drawImage(video, Math.round(center - half), Math.round((sh - h) / 2), w, h, 0, 0, w, h);
      Object.assign(state, { center, target, mode: detector ? 'follow' : 'center' });
    }
    schedule();
  }

  const schedule = 'requestVideoFrameCallback' in HTMLVideoElement.prototype
    ? () => video.requestVideoFrameCallback((now) => frame(now))
    : () => requestAnimationFrame(frame);
  schedule();

  return {
    state,
    stop() { running = false; },
  };
}
