// Vertical inteligente: recorta 9:16 do vídeo da câmera num canvas e acompanha o rosto.
// Detecção a ~15 fps; o recorte anda a cada quadro com suavização, zona morta e
// velocidade máxima, para não "tremer". O canvas é o preview ao vivo; a gravação é o
// quadro horizontal + o caminho do recorte, e o vertical é gerado depois (renderVertical).

const DETECT_EVERY_MS = 66;
const DET_SIZE = 256;        // lado da janela enviada ao detector
const VENDOR_CACHE = 'teleprompter-vendor-mediapipe-0.10.34'; // igual ao sw.js
const DEAD_ZONE = 0.035;     // fração da largura da fonte: dentro disso não começa a mexer
const SETTLE = 0.01;         // já andando: para quando chega tão perto do alvo
const SMOOTH_TAU = 0.16;     // s — quanto maior, mais suave (e mais atrasado)
const MAX_SPEED = 1.6;       // fração da largura da fonte por segundo
const LOOKAHEAD_MS = 200;    // no vertical gerado, o recorte antecipa o movimento (compensa o atraso)
const LOST_AFTER_MS = 1500;  // sem rosto por esse tempo → volta devagar ao centro

let detectorPromise = null;
const VENDOR_FILES = ['vision_bundle.mjs', 'wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm', 'blaze_face_short_range.tflite'];
const vendorBase = () => new URL('../vendor/mediapipe/', import.meta.url).href;

/** Recorta a janela do quadro e reduz para o detector. */
function drawWindow(ctx, video, rx, ry, side) {
  ctx.drawImage(video, rx, ry, side, side, 0, 0, DET_SIZE, DET_SIZE);
}

/** MediaPipe num Web Worker: a detecção não disputa a thread que desenha a tela. */
async function workerDetector() {
  const worker = new Worker(new URL('./face-worker.js', import.meta.url), { type: 'module' });
  let seq = 0;
  const pending = new Map();
  const failAll = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); };
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) p?.reject(new Error(data.error)); else p?.resolve(data);
  };
  worker.onerror = (e) => { e.preventDefault?.(); failAll(new Error(e.message || 'worker')); };
  const call = (msg, transfer = []) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
  try {
    const { engine } = await call({ type: 'init' });
    return {
      engine: `MediaPipe ${engine} · worker`,
      async detect(video, rx, ry, side) {
        const bitmap = await createImageBitmap(video, rx, ry, side, side, { resizeWidth: DET_SIZE, resizeHeight: DET_SIZE, resizeQuality: 'low' });
        return (await call({ type: 'detect', bitmap }, [bitmap])).faces;
      },
    };
  } catch (err) {
    worker.terminate();
    throw err;
  }
}

/** Reserva: MediaPipe na thread principal (bloqueia a tela durante cada detecção). */
async function mainThreadDetector() {
  const { FaceDetector } = await import('../vendor/mediapipe/vision_bundle.mjs');
  const base = vendorBase();
  const fileset = {
    wasmLoaderPath: base + 'wasm/vision_wasm_internal.js',
    wasmBinaryPath: base + 'wasm/vision_wasm_internal.wasm',
  };
  const create = (delegate) => FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: base + 'blaze_face_short_range.tflite', delegate },
    runningMode: 'VIDEO',
    minDetectionConfidence: 0.5,
  });
  let engine = 'GPU';
  const mp = await create('GPU').catch(() => { engine = 'CPU'; return create('CPU'); });
  const c = document.createElement('canvas');
  c.width = c.height = DET_SIZE;
  const ctx = c.getContext('2d');
  return {
    engine: `MediaPipe ${engine} · principal`,
    async detect(video, rx, ry, side) {
      drawWindow(ctx, video, rx, ry, side);
      return mp.detectForVideo(c, performance.now()).detections.map((d) => {
        const bb = d.boundingBox;
        return { x: bb.originX, y: bb.originY, width: bb.width, height: bb.height };
      });
    },
  };
}

/** Detector de rosto: MediaPipe em worker; senão nativo (Shape Detection); senão MediaPipe na thread principal. */
function loadDetector() {
  detectorPromise ??= (async () => {
    let det = null;
    if (window.Worker && window.createImageBitmap) det = await workerDetector().catch(() => null);
    if (!det && 'FaceDetector' in window) {
      try {
        const native = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 3 });
        const c = document.createElement('canvas');
        c.width = c.height = DET_SIZE;
        const ctx = c.getContext('2d');
        det = {
          engine: 'nativo',
          async detect(video, rx, ry, side) {
            drawWindow(ctx, video, rx, ry, side);
            return (await native.detect(c)).map((f) => f.boundingBox);
          },
        };
      } catch { /* segue */ }
    }
    det ??= await mainThreadDetector();
    // Garante tudo no cache offline (na 1ª visita o carregamento pode sair antes do service
    // worker assumir a página). O que já está em cache é servido por ele, sem novo download.
    if (det.engine.startsWith('MediaPipe')) {
      globalThis.caches?.open(VENDOR_CACHE).then((c) => c.addAll(VENDOR_FILES.map((f) => vendorBase() + f))).catch(() => {});
    }
    return det;
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
  let hadFace = false; // a última detecção achou o rosto? (senão já varre as laterais)
  let moving = false;
  const state = { center: 0, target: 0, faces: 0, mode: 'center', detections: 0, detectMs: 0, engine: '', fps: 0 };
  let fpsCount = 0;
  let fpsT0 = 0;
  let paused = false;
  let path = null; // caminho do recorte durante a gravação: [{ t (ms desde o início), c (centro) }]
  let pathT0 = 0;

  if (follow) {
    onStatus('loading');
    loadDetector()
      .then((d) => { detector = d; state.engine = d.engine; onStatus('ready'); })
      .catch(() => onStatus('error'));
  }

  function frame(now) {
    if (!running) return;
    const sw = video.videoWidth;
    const sh = video.videoHeight;
    if (sw && sh && !paused) {
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

      // Celular em pé: o quadro já é vertical e o recorte é ele inteiro — nada a seguir.
      const portrait = sw - w < 2;
      if (detector && !portrait && !busy && now - lastDetect > DETECT_EVERY_MS) {
        lastDetect = now;
        busy = true;
        // O modelo reduz a entrada a 128 px: no quadro 16:9 inteiro o rosto some.
        // Detecta numa janela quadrada (altura do quadro) onde o rosto estava; perdido,
        // varre as janelas esquerda e direita (juntas cobrem o quadro), começando pelo lado oposto.
        const side = Math.min(sw, sh);
        const found = hadFace;
        if (found) scan = 0;
        const cx = found ? target : [side / 2, sw - side / 2][(target < sw / 2 ? 1 : 0) ^ (scan++ & 1)];
        const rx = Math.round(Math.max(0, Math.min(sw - side, cx - side / 2)));
        const ry = Math.round((sh - side) / 2);
        const k = side / DET_SIZE;
        const t0 = performance.now();
        detector.detect(video, rx, ry, side).then((faces) => {
          state.detections++;
          state.detectMs = Math.round(performance.now() - t0);
          if (faces.length) {
            // Maior rosto = quem está lendo.
            const f = faces.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
            target = rx + (f.x + f.width / 2) * k;
            lastFaceAt = performance.now();
          }
          state.faces = faces.length;
          hadFace = faces.length > 0;
        }).catch(() => {}).finally(() => { busy = false; });
      }
      if (!detector || performance.now() - lastFaceAt > LOST_AFTER_MS) target = sw / 2;

      ({ center, moving } = stepCenter(center, target, dt, sw, moving));
      const half = w / 2;
      center = Math.max(half, Math.min(sw - half, center));
      ctx.drawImage(video, Math.round(center - half), Math.round((sh - h) / 2), w, h, 0, 0, w, h);
      path?.push({ t: performance.now() - pathT0, c: center });
      // Quadros por segundo do preview (diagnóstico no painel Câmera e áudio).
      fpsCount++;
      if (now - fpsT0 >= 1000) { state.fps = Math.round((fpsCount * 1000) / (now - fpsT0)); fpsCount = 0; fpsT0 = now; }
      Object.assign(state, { center, target, mode: portrait ? 'portrait' : detector ? 'follow' : 'center' });
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
    /** Pausa o preview e a detecção (libera o aparelho enquanto o vertical é gerado). */
    pause(v) { paused = v; },
    beginPath() { path = []; pathT0 = performance.now(); },
    endPath() { const p = path || []; path = null; return p; },
  };
}

/** Centro do recorte no instante t (ms), interpolado no caminho gravado. */
export function centerAt(path, t, fallback) {
  if (!path.length) return fallback;
  if (t <= path[0].t) return path[0].c;
  const last = path[path.length - 1];
  if (t >= last.t) return last.c;
  let lo = 0;
  let hi = path.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = path[lo];
  const b = path[hi];
  return a.c + ((b.c - a.c) * (t - a.t)) / (b.t - a.t || 1);
}

/**
 * Gera o vídeo vertical a partir da gravação horizontal + caminho do recorte.
 * Toca o vídeo (sem som nos alto-falantes) e regrava o recorte: leva ~ a duração do vídeo.
 * Se o app for para segundo plano, pausa e continua ao voltar. Retorna null se abortado.
 */
export async function renderVertical(blob, path, { fps = 30, mimeType = '', onProgress = () => {}, signal } = {}) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  // No DOM (invisível): alguns navegadores não entregam quadros de vídeo fora do documento.
  video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(video);
  const ac = new AudioContext();
  let rec = null;
  let tracks = [];
  let watchdog = 0;
  const onVis = () => {
    if (!rec || rec.state === 'inactive') return;
    if (document.hidden) { video.pause(); rec.pause(); } else { rec.resume(); video.play().catch(() => {}); }
  };
  try {
    video.src = url;
    await new Promise((res, rej) => {
      video.onloadeddata = res;
      video.onerror = () => rej(new Error('Não foi possível ler a gravação.'));
    });
    const sw = video.videoWidth;
    const sh = video.videoHeight;
    const { w, h } = cropSize(sw, sh);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    // Áudio do vídeo vai para a gravação, não para os alto-falantes.
    const dst = ac.createMediaStreamDestination();
    ac.createMediaElementSource(video).connect(dst);
    await ac.resume().catch(() => {});
    tracks = [canvas.captureStream(fps).getVideoTracks()[0], ...dst.stream.getAudioTracks()];
    rec = new MediaRecorder(new MediaStream(tracks), {
      ...(mimeType && { mimeType }),
      videoBitsPerSecond: Math.max(2_500_000, Math.round(w * h * fps * 0.13)),
      audioBitsPerSecond: 128_000,
    });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((res) => { rec.onstop = res; });
    const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (path.length ? path[path.length - 1].t / 1000 : 1);
    const draw = (sec) => {
      const c = centerAt(path, sec * 1000 + LOOKAHEAD_MS, sw / 2);
      const x = Math.round(Math.max(0, Math.min(sw - w, c - w / 2)));
      ctx.drawImage(video, x, Math.round((sh - h) / 2), w, h, 0, 0, w, h);
      onProgress(Math.min(1, sec / total));
    };
    let done = false;
    if ('requestVideoFrameCallback' in video) {
      const onFrame = (_, meta) => { if (done) return; draw(meta.mediaTime); video.requestVideoFrameCallback(onFrame); };
      video.requestVideoFrameCallback(onFrame);
    } else {
      const loop = () => { if (done) return; draw(video.currentTime); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }
    draw(0);
    document.addEventListener('visibilitychange', onVis);
    rec.start();
    // Arquivos do MediaRecorder costumam ter um rabo sem quadros: a reprodução empaca a
    // ~0,2 s do fim e o 'ended' demora segundos. Empacou no último segundo = acabou.
    let stuck = 0;
    let lastCT = -1;
    const ended = new Promise((res) => {
      video.onended = res;
      watchdog = setInterval(() => {
        if (document.hidden || video.paused) return;
        const end = Number.isFinite(video.duration) ? video.duration : total;
        stuck = video.currentTime === lastCT ? stuck + 250 : 0;
        lastCT = video.currentTime;
        if (stuck >= 750 && video.currentTime >= end - 1) res();
      }, 250);
    });
    const aborted = new Promise((res) => signal?.addEventListener('abort', res, { once: true }));
    await video.play();
    await Promise.race([ended, aborted]);
    clearInterval(watchdog);
    done = true;
    video.pause();
    rec.stop();
    await stopped;
    if (signal?.aborted) return null;
    onProgress(1);
    return new Blob(chunks, { type: rec.mimeType || mimeType || 'video/webm' });
  } finally {
    document.removeEventListener('visibilitychange', onVis);
    clearInterval(watchdog);
    tracks.forEach((t) => t.stop());
    ac.close().catch(() => {});
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}
