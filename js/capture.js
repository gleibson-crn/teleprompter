// Captura: câmera + microfone (cadeia de áudio) + Vertical inteligente (preview em canvas).
// Decide o que é gravado e expõe os controles de câmera que o aparelho suporta.
import { audioConstraints, createAudioChain, listMics } from './audio.js';
import { createReframe } from './reframe.js';

// Mudou alguma destas → precisa reabrir a câmera/microfone.
const keyOf = (s) => [s.facing, s.vertical ? 1080 : s.res, s.fps, s.micId, s.audioMode, s.vertical, s.follow].join('|');

export function pickMime(kind = 'video') {
  const types = kind === 'video'
    ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

export function createCapture({ video, canvas, getSettings, setSetting, toast, onReframeStatus, onFrameResize }) {
  let stream = null;
  let chain = null;
  let reframe = null;
  let key = '';

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      toast('Este navegador não suporta gravação de vídeo.');
      return false;
    }
    let s = getSettings();
    // Vertical: fonte 1080p para o recorte 9:16 ter ~608×1080 reais (sem ampliar).
    const hi = s.vertical || s.res === 1080;
    const videoC = {
      facingMode: { ideal: s.facing },
      width: { ideal: hi ? 1920 : 1280 },
      height: { ideal: hi ? 1080 : 720 },
      frameRate: { ideal: s.fps, max: s.fps },
      zoom: true, // o Chrome só expõe o zoom se for pedido aqui
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoC, audio: audioConstraints(s) });
    } catch (err) {
      if (s.micId && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
        // Microfone salvo sumiu (ex.: fone desconectado): volta ao padrão.
        s = { ...s, micId: '' };
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: videoC, audio: audioConstraints(s) });
          toast('Microfone escolhido não encontrado — usando o padrão.');
        } catch (e) { err = e; }
      }
      if (!stream) {
        toast(err?.name === 'NotAllowedError'
          ? 'Permissão de câmera/microfone negada. Libere nas configurações do site.'
          : 'Não foi possível abrir a câmera.');
        return false;
      }
    }
    key = keyOf(s);
    if (s.micId !== getSettings().micId) setSetting('micId', '');

    video.srcObject = stream;
    video.hidden = false;
    await video.play().catch(() => {});
    chain = createAudioChain(stream, s);
    if (s.vertical) {
      canvas.hidden = false;
      reframe = createReframe(video, canvas, { follow: s.follow, onStatus: onReframeStatus, onResize: onFrameResize });
    } else {
      canvas.hidden = true;
    }
    return true;
  }

  function stop() {
    reframe?.stop();
    reframe = null;
    chain?.close();
    chain = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    video.hidden = true;
    canvas.hidden = true;
    key = '';
  }

  /**
   * Stream a gravar (câmera + áudio tratado) e bitrate adequado. Sempre o quadro horizontal
   * direto da câmera (um só codificador, o mais leve). No Vertical inteligente, `vertical`
   * grava o caminho do recorte para gerar o 9:16 depois (renderVertical).
   */
  function recording() {
    const s = getSettings();
    const vTrack = stream.getVideoTracks()[0];
    const { width: w = 1280, height: h = 720, frameRate } = vTrack.getSettings();
    const fps = frameRate || s.fps;
    const rf = reframe;
    return {
      stream: new MediaStream([vTrack, ...chain.stream.getAudioTracks()]),
      videoBitsPerSecond: Math.max(2_500_000, Math.round(w * h * fps * 0.13)),
      fps: Math.round(fps),
      vertical: rf && { begin: () => rf.beginPath(), end: () => rf.endPath() },
    };
  }

  // ---------- Controles de câmera (só os que o aparelho expõe) ----------
  function controls() {
    const track = stream?.getVideoTracks()[0];
    if (!track?.getCapabilities) return [];
    const caps = track.getCapabilities();
    const cur = track.getSettings();
    const list = [];
    if (caps.zoom && caps.zoom.max > caps.zoom.min) {
      list.push({ name: 'zoom', label: 'Zoom', type: 'range', ...caps.zoom, value: cur.zoom ?? caps.zoom.min, fmt: (v) => `${(+v).toFixed(1)}×` });
    }
    if (caps.exposureCompensation && caps.exposureCompensation.max > caps.exposureCompensation.min) {
      list.push({ name: 'exposureCompensation', label: 'Exposição', type: 'range', ...caps.exposureCompensation, value: cur.exposureCompensation ?? 0, fmt: (v) => (v > 0 ? '+' : '') + (+v).toFixed(1) });
    }
    if (caps.focusMode?.includes('manual') && caps.focusDistance) {
      list.push({ name: 'focusManual', label: 'Foco manual', type: 'toggle', value: cur.focusMode === 'manual' });
      list.push({ name: 'focusDistance', label: 'Distância do foco', type: 'range', ...caps.focusDistance, value: cur.focusDistance ?? caps.focusDistance.min, fmt: (v) => (+v).toFixed(2) });
    }
    if (caps.torch) list.push({ name: 'torch', label: 'Lanterna', type: 'toggle', value: !!cur.torch });
    return list;
  }

  async function setControl(name, value) {
    const track = stream?.getVideoTracks()[0];
    if (!track) return;
    const c = name === 'focusManual'
      ? { focusMode: value ? 'manual' : (track.getCapabilities().focusMode?.includes('continuous') ? 'continuous' : 'single-shot') }
      : name === 'focusDistance' ? { focusMode: 'manual', focusDistance: value } : { [name]: value };
    try { await track.applyConstraints({ advanced: [c] }); } catch { toast('O aparelho recusou esse ajuste.'); }
  }

  // ---------- Microfone ----------
  async function testMic(seconds, onTick) {
    await chain.resume();
    const mimeType = pickMime('audio');
    const recs = [chain.rawStream, chain.stream].map((st) => {
      const r = new MediaRecorder(st, mimeType ? { mimeType } : undefined);
      const chunks = [];
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const done = new Promise((res) => { r.onstop = () => res(new Blob(chunks, { type: r.mimeType || mimeType })); });
      r.start();
      return { r, done };
    });
    for (let i = seconds; i > 0; i--) {
      onTick?.(i);
      await new Promise((res) => setTimeout(res, 1000));
    }
    recs.forEach(({ r }) => r.stop());
    const [raw, processed] = await Promise.all(recs.map((x) => x.done));
    return { raw, processed };
  }

  function micInfo() {
    const t = stream?.getAudioTracks()[0];
    if (!t) return null;
    const st = t.getSettings();
    return { label: t.label, noiseSuppression: st.noiseSuppression, echoCancellation: st.echoCancellation, autoGainControl: st.autoGainControl, sampleRate: st.sampleRate };
  }

  return {
    start,
    stop,
    active: () => !!stream,
    needsRestart: () => !!stream && keyOf(getSettings()) !== key,
    applyAudio: (s) => chain?.apply(s),
    resumeAudio: () => chain?.resume(),
    level: () => chain?.level(),
    recording,
    controls,
    setControl,
    listMics,
    testMic,
    micInfo,
    reframeState: () => reframe?.state,
    pauseReframe: (v) => reframe?.pause(v),
    isVertical: () => !!reframe,
    videoSize: () => (reframe ? { w: canvas.width, h: canvas.height } : { w: video.videoWidth, h: video.videoHeight }),
  };
}
