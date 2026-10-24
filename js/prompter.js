// Motor do teleprompter: rolagem por tempo (independe do FPS), gestos, contagem
// regressiva, Wake Lock, tela cheia e — no modo câmera — preview + gravação.
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);
const LINE_HEIGHT = 1.35;

export function createPrompter({ getSettings, setSetting, toast }) {
  const view = $('view-prompter');
  const stage = $('stage');
  const inner = $('stage-inner');
  const text = $('prompt-text');
  const controls = $('controls');
  const btnToggle = $('btn-toggle');
  const btnRec = $('btn-rec');
  const progressBar = $('progress-bar');
  const countdownEl = $('countdown');
  const video = $('cam-video');

  let pos = 0;
  let maxPos = 0;
  let playing = false;
  let lastT = 0;
  let raf = 0;
  let countdownTimer = 0;
  let active = false;
  let cameraMode = false;
  let stream = null;
  let streamHd = false;
  let recorder = null;
  let recChunks = [];
  let recStart = 0;
  let recTimer = 0;
  let recBlob = null;
  let wakeLock = null;

  // ---------- Layout ----------
  function applySettings() {
    const s = getSettings();
    const root = document.documentElement.style;
    root.setProperty('--font-size', s.fontSize + 'px');
    root.setProperty('--margin', s.margin + 'vw');
    root.setProperty('--guide-pos', s.guidePos + '%');
    root.setProperty('--align', s.center ? 'center' : 'left');
    inner.classList.toggle('mirror-h', s.mirrorH);
    inner.classList.toggle('mirror-v', s.mirrorV);
    $('guide').hidden = !s.guide;
    $('speed-value').textContent = s.speed;
    layout();
    // Mudou a qualidade com a câmera aberta (e sem gravar): reabre na nova resolução.
    if (stream && s.hd !== streamHd && recorder?.state !== 'recording') {
      stopCamera();
      startCamera();
    }
  }

  function layout() {
    if (!active) return;
    const ratio = maxPos > 0 ? pos / maxPos : 0;
    const s = getSettings();
    const h = stage.clientHeight;
    const line = s.fontSize * LINE_HEIGHT;
    // Primeira linha começa centrada na linha de leitura; a última pode chegar até ela.
    text.style.paddingTop = Math.max(0, h * s.guidePos / 100 - line / 2) + 'px';
    text.style.paddingBottom = Math.max(0, h * (1 - s.guidePos / 100) - line / 2) + 'px';
    maxPos = Math.max(0, text.offsetHeight - h);
    setPos(ratio * maxPos);
  }

  function setPos(p) {
    pos = Math.min(Math.max(p, 0), maxPos);
    // Alinha ao pixel físico da tela: evita reamostrar o texto a cada quadro.
    const dpr = window.devicePixelRatio || 1;
    text.style.transform = `translate3d(0, ${-Math.round(pos * dpr) / dpr}px, 0)`;
    progressBar.style.width = (maxPos ? (pos / maxPos) * 100 : 0) + '%';
  }

  // ---------- Rolagem ----------
  function tick(t) {
    const dt = Math.min((t - lastT) / 1000, 0.1);
    lastT = t;
    const s = getSettings();
    setPos(pos + (s.speed * s.fontSize / 10) * dt);
    if (pos >= maxPos) return pause();
    raf = requestAnimationFrame(tick);
  }

  function start() {
    playing = true;
    renderState();
    lastT = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function play() {
    if (playing || countdownTimer) return;
    if (pos >= maxPos) setPos(0);
    const secs = getSettings().countdown;
    if (pos > 0 || secs <= 0) return start();
    let n = secs;
    countdownEl.textContent = n;
    countdownEl.hidden = false;
    countdownTimer = setInterval(() => {
      n--;
      if (n > 0) { countdownEl.textContent = n; return; }
      cancelCountdown();
      start();
    }, 1000);
    renderState();
  }

  function cancelCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = 0;
    countdownEl.hidden = true;
    renderState();
  }

  function pause() {
    cancelAnimationFrame(raf);
    playing = false;
    renderState();
  }

  function toggle() {
    if (countdownTimer) return cancelCountdown();
    playing ? pause() : play();
  }

  function renderState() {
    btnToggle.innerHTML = icon(playing ? 'pause' : 'play');
    // No modo câmera os controles ficam sempre visíveis (botão de parar a gravação).
    controls.classList.toggle('hide', !cameraMode && (playing || !!countdownTimer));
  }

  function changeSpeed(delta) {
    const s = getSettings();
    setSetting('speed', Math.min(40, Math.max(1, s.speed + delta)));
    $('speed-value').textContent = getSettings().speed;
  }

  // ---------- Gestos: toque = play/pausa, arrastar = posicionar ----------
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!$('settings').hidden) { $('settings').hidden = true; return; }
    if (!$('rec-result').hidden) return;
    drag ={ y: e.clientY, pos, moved: false, wasPlaying: playing };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = (e.clientY - drag.y) * (getSettings().mirrorV ? -1 : 1);
    if (!drag.moved && Math.abs(dy) > 8) {
      drag.moved = true;
      if (playing) pause();
    }
    if (drag.moved) setPos(drag.pos - dy);
  });
  stage.addEventListener('pointerup', () => {
    if (!drag) return;
    const { moved, wasPlaying } = drag;
    drag = null;
    if (!moved) toggle();
    else if (wasPlaying) start();
  });
  stage.addEventListener('pointercancel', () => { drag = null; });
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    setPos(pos + e.deltaY * (getSettings().mirrorV ? -1 : 1));
  }, { passive: false });

  // Teclado / pedal Bluetooth
  document.addEventListener('keydown', (e) => {
    if (!active || e.target.closest?.('input, textarea')) return;
    const page = stage.clientHeight * 0.4;
    switch (e.key) {
      case ' ': case 'Enter': toggle(); break;
      case 'ArrowUp': changeSpeed(1); break;
      case 'ArrowDown': changeSpeed(-1); break;
      case 'PageDown': case 'ArrowRight': setPos(pos + page); break;
      case 'PageUp': case 'ArrowLeft': setPos(pos - page); break;
      case 'Home': setPos(0); break;
      case 'Escape': return;
      default: return;
    }
    e.preventDefault();
  });

  // ---------- Wake Lock / tela cheia ----------
  async function lockScreen() {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* sem suporte */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && active) lockScreen();
    else if (document.visibilityState === 'hidden' && playing) pause();
  });
  window.addEventListener('resize', () => layout());

  function enterFullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }
  function exitFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  // ---------- Câmera e gravação ----------
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      toast('Este navegador não suporta gravação de vídeo.');
      return false;
    }
    // 720p30 por padrão: codificar 1080p no navegador disputa CPU com o preview e a rolagem.
    const hd = getSettings().hd;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: hd ? 1920 : 1280 },
          height: { ideal: hd ? 1080 : 720 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamHd = hd;
    } catch (err) {
      toast(err?.name === 'NotAllowedError'
        ? 'Permissão de câmera/microfone negada. Libere nas configurações do site.'
        : 'Não foi possível abrir a câmera.');
      return false;
    }
    video.srcObject = stream;
    video.hidden = false;
    await video.play().catch(() => {});
    return true;
  }

  function stopCamera() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    video.hidden = true;
  }

  function pickMime() {
    const types = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  function startRecording() {
    const mimeType = pickMime();
    recChunks = [];
    recorder = new MediaRecorder(stream, {
      ...(mimeType && { mimeType }),
      videoBitsPerSecond: streamHd ? 8_000_000 : 4_000_000,
      audioBitsPerSecond: 128_000,
    });
    recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    recorder.onstop = showRecording;
    // Sem timeslice: um único bloco no fim, em vez de picos de trabalho a cada segundo.
    recorder.start();
    recStart = Date.now();
    $('rec-badge').hidden = false;
    $('rec-time').textContent = '00:00';
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      $('rec-time').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
    btnRec.classList.add('on');
    btnRec.innerHTML = icon('square');
  }

  function stopRecording() {
    clearInterval(recTimer);
    $('rec-badge').hidden = true;
    btnRec.classList.remove('on');
    btnRec.innerHTML = icon('video');
    if (recorder?.state !== 'inactive') recorder?.stop();
  }

  function toggleRecording() {
    if (recorder?.state === 'recording') {
      stopRecording();
      pause();
      return;
    }
    if (!stream) return;
    // Grava a partir do fim da contagem regressiva.
    if (pos > 0 || getSettings().countdown <= 0) { startRecording(); play(); return; }
    play();
    const wait = setInterval(() => {
      if (countdownTimer) return;
      clearInterval(wait);
      if (playing) startRecording();
    }, 50);
  }

  function showRecording() {
    const type = recorder.mimeType || recChunks[0]?.type || 'video/webm';
    recBlob = new Blob(recChunks, { type });
    recorder = null;
    const preview = $('rec-preview');
    preview.src = URL.createObjectURL(recBlob);
    const file = recFile();
    $('btn-rec-share').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    $('rec-result').hidden = false;
  }

  function recFile() {
    const ext = recBlob.type.includes('mp4') ? 'mp4' : 'webm';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    return new File([recBlob], `teleprompter-${stamp}.${ext}`, { type: recBlob.type });
  }

  function closeRecording() {
    const preview = $('rec-preview');
    preview.pause();
    if (preview.src) URL.revokeObjectURL(preview.src);
    preview.removeAttribute('src');
    preview.load(); // descarrega a mídia; sem isso o áudio segue tocando em segundo plano
    recBlob = null;
    $('rec-result').hidden = true;
  }

  function saveRecording() {
    const file = recFile();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('Vídeo salvo em Downloads.');
    closeRecording();
  }

  async function shareRecording() {
    try {
      await navigator.share({ files: [recFile()], title: 'Teleprompter' });
      closeRecording();
    } catch { /* cancelado */ }
  }

  // ---------- Ciclo de vida ----------
  async function open(script, { camera = false } = {}) {
    active = true;
    cameraMode = camera;
    view.classList.toggle('camera', camera);
    btnRec.hidden = !camera;
    btnRec.innerHTML = icon('video');
    text.textContent = script.text || '';
    pos = 0;
    maxPos = 0;
    $('settings').hidden = true;
    closeRecording();
    enterFullscreen();
    lockScreen();
    applySettings();
    renderState();
    if (camera && !(await startCamera())) {
      btnRec.hidden = true;
      view.classList.remove('camera');
      layout();
    }
  }

  function close() {
    if (!active) return;
    if (recorder?.state === 'recording') {
      recorder.onstop = null;
      stopRecording();
    }
    pause();
    cancelCountdown();
    stopCamera();
    closeRecording();
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    exitFullscreen();
    active = false;
  }

  return {
    open, close, applySettings, toggle, changeSpeed,
    restart: () => { pause(); cancelCountdown(); setPos(0); },
    toggleRecording, saveRecording, shareRecording, discardRecording: closeRecording,
    isRecording: () => recorder?.state === 'recording',
    isCamera: () => cameraMode,
  };
}
