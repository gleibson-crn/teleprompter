// Motor do teleprompter: rolagem por tempo (independe do FPS), gestos, contagem
// regressiva, Wake Lock e — no modo câmera — preview + gravação (horizontal + vertical gerado).
import { icon } from './icons.js';
import { createCapture, pickMime } from './capture.js';
import { cropSize, renderVertical } from './reframe.js';

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
  const canvas = $('cam-canvas');

  let pos = 0;
  let maxPos = 0;
  let playing = false;
  let lastT = 0;
  let raf = 0;
  let countdownTimer = 0;
  let active = false;
  let cameraMode = false;
  let recorder = null;
  let recChunks = [];
  let recStart = 0;
  let recTimer = 0;
  let recVertical = null; // gravação no Vertical inteligente: { end() → caminho do recorte }
  let recFps = 30;
  // Resultado: blobs por formato ('h' horizontal, 'v' vertical) e o formato exibido.
  let recBlobs = {};
  let recSel = 'h';
  let renderAbort = null;
  let recInfo = null; // diagnóstico do caminho do recorte da última gravação
  let wakeLock = null;
  let meterTimer = 0;
  let restarting = false;

  const capture = createCapture({
    video, canvas, getSettings, setSetting, toast,
    onFrameResize: () => positionOverlay(),
    onReframeStatus: (st) => {
      const el = $('reframe-status');
      el.hidden = st === 'ready';
      el.textContent = st === 'loading' ? 'Carregando detector de rosto…' : st === 'error' ? 'Detector de rosto indisponível — recorte centralizado.' : '';
      if (st === 'error') setTimeout(() => { el.hidden = true; }, 4000);
    },
  });

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
    capture.applyAudio(s);
    updateCameraClasses();
    layout();
    // Trocou câmera/resolução/microfone com a câmera aberta (e sem gravar): reabre.
    if (cameraMode && capture.needsRestart() && !isRecording()) restartCamera();
  }

  function updateCameraClasses() {
    const s = getSettings();
    const type = screen.orientation?.type || '';
    const landscape = type ? type.startsWith('landscape') : innerWidth > innerHeight;
    view.classList.toggle('landscape', landscape);
    // landscape-primary: topo do aparelho (lente frontal) à esquerda.
    view.classList.toggle('lens-right', type === 'landscape-secondary');
    view.classList.toggle('vertical', cameraMode && capture.isVertical());
    view.classList.toggle('rear', s.facing === 'environment');
    $('grid').hidden = !s.grid;
    $('guide916').hidden = !(s.guide916 && !capture.isVertical());
    $('frame-overlay').hidden = !cameraMode || !capture.active() || (!s.grid && $('guide916').hidden);
    positionOverlay();
  }

  /** Posiciona grade/guia sobre a área visível do preview (considera object-fit). */
  function positionOverlay() {
    const ov = $('frame-overlay');
    if (ov.hidden) return;
    const vertical = capture.isVertical();
    const el = vertical ? canvas : video;
    const { w: iw, h: ih } = capture.videoSize();
    if (!iw || !ih) return;
    const r = el.getBoundingClientRect();
    const scale = (vertical ? Math.min : Math.max)(r.width / iw, r.height / ih);
    const cw = iw * scale;
    const ch = ih * scale;
    const left = Math.max(r.left, r.left + (r.width - cw) / 2);
    const top = Math.max(r.top, r.top + (r.height - ch) / 2);
    const right = Math.min(r.right, r.left + (r.width + cw) / 2);
    const bottom = Math.min(r.bottom, r.top + (r.height + ch) / 2);
    Object.assign(ov.style, { left: left + 'px', top: top + 'px', width: right - left + 'px', height: bottom - top + 'px' });
    // Guia 9:16: o recorte máximo da fonte, centralizado, em coordenadas de tela.
    const crop = cropSize(iw, ih);
    const g = $('guide916').style;
    g.width = crop.w * scale + 'px';
    g.height = crop.h * scale + 'px';
    g.left = (r.left + r.width / 2 - left) - (crop.w * scale) / 2 + 'px';
    g.top = (r.top + r.height / 2 - top) - (crop.h * scale) / 2 + 'px';
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
  const sheets = ['settings', 'av'];
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    const open = sheets.find((id) => !$(id).hidden);
    if (open) { $(open).hidden = true; return; }
    if (!$('rec-result').hidden) return;
    drag = { y: e.clientY, pos, moved: false, wasPlaying: playing };
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
    if (!active || e.target.closest?.('input, textarea, select')) return;
    const page = stage.clientHeight * 0.4;
    switch (e.key) {
      case ' ': case 'Enter': toggle(); break;
      case 'ArrowUp': changeSpeed(1); break;
      case 'ArrowDown': changeSpeed(-1); break;
      case 'PageDown': case 'ArrowRight': setPos(pos + page); break;
      case 'PageUp': case 'ArrowLeft': setPos(pos - page); break;
      case 'Home': setPos(0); break;
      default: return;
    }
    e.preventDefault();
  });

  // ---------- Wake Lock / tela cheia / orientação ----------
  async function lockScreen() {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* sem suporte */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && active) lockScreen();
    else if (document.visibilityState === 'hidden' && playing) pause();
  });
  const onResize = () => { if (!active) return; updateCameraClasses(); layout(); };
  window.addEventListener('resize', onResize);
  screen.orientation?.addEventListener('change', onResize);
  video.addEventListener('resize', () => positionOverlay());

  // ---------- Câmera ----------
  async function startCamera() {
    const ok = await capture.start();
    $('btn-av').hidden = !ok;
    $('meter').hidden = !ok;
    clearInterval(meterTimer);
    if (ok) meterTimer = setInterval(renderMeter, 70);
    updateCameraClasses();
    layout();
    if (!$('av').hidden) renderAv();
    return ok;
  }

  async function restartCamera() {
    if (restarting) return;
    restarting = true;
    capture.stop();
    await startCamera();
    restarting = false;
    // Algo mudou durante a reabertura? Reabre de novo com o estado atual.
    if (cameraMode && capture.needsRestart()) restartCamera();
  }

  function stopCamera() {
    clearInterval(meterTimer);
    capture.stop();
    $('meter').hidden = true;
    $('btn-av').hidden = true;
    $('reframe-status').hidden = true;
    updateCameraClasses();
  }

  function renderMeter() {
    // Desempenho do Vertical inteligente, ao vivo no painel (para diagnosticar travadas).
    const rf = capture.reframeState();
    const perf = $('perf-info');
    perf.hidden = !rf;
    if (rf && !$('av').hidden) {
      perf.textContent = `Desempenho: preview ${rf.fps || '–'} fps · detector ${rf.engine || 'carregando'}${rf.detectMs ? ` · ${rf.detectMs} ms` : ''}`;
    }
    const lv = capture.level();
    if (!lv) return;
    // -60 dBFS → 0%, 0 dBFS → 100%
    const pct = Math.max(0, Math.min(100, ((lv.peak + 60) / 60) * 100));
    const clip = lv.peak > -1;
    for (const el of [$('meter').firstElementChild, $('meter-wide-fill')]) {
      el.style.setProperty('--level', pct + '%');
      el.classList.toggle('clip', clip);
    }
  }

  // ---------- Painel Câmera e áudio ----------
  async function renderAv() {
    $('av-locked').hidden = !isRecording();
    for (const el of $('av').querySelectorAll('[data-restart]')) el.disabled = isRecording();

    // Microfones (os nomes só aparecem depois da permissão).
    const sel = $('mic-select');
    const mics = await capture.listMics().catch(() => []);
    const s = getSettings();
    sel.replaceChildren(new Option('Padrão do sistema', ''), ...mics
      .filter((m) => m.deviceId && m.deviceId !== 'default')
      .map((m, i) => new Option(m.label || `Microfone ${i + 1}`, m.deviceId)));
    sel.value = s.micId;
    if (sel.value !== s.micId) sel.value = '';

    const info = capture.micInfo();
    $('mic-info').textContent = info
      ? `Em uso: ${info.label || 'microfone'}${info.sampleRate ? ` · ${Math.round(info.sampleRate / 1000)} kHz` : ''} · redução de ruído do aparelho: ${info.noiseSuppression ? 'ligada' : 'desligada'}`
      : '';

    // Controles que o aparelho suporta.
    const box = $('cam-controls');
    box.replaceChildren(...capture.controls().map((c) => {
      const label = document.createElement('label');
      if (c.type === 'toggle') {
        label.className = 'toggle';
        const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: c.value });
        input.addEventListener('change', () => capture.setControl(c.name, input.checked));
        label.append(input, c.label);
      } else {
        label.className = 'field';
        const out = document.createElement('output');
        out.textContent = c.fmt(c.value);
        const input = Object.assign(document.createElement('input'), { type: 'range', min: c.min, max: c.max, step: c.step || 'any', value: c.value });
        input.addEventListener('input', () => { out.textContent = c.fmt(input.value); capture.setControl(c.name, Number(input.value)); });
        label.append(c.label + ' ', out, input);
      }
      return label;
    }));
  }

  let micTest = null;
  async function testMic() {
    if (!capture.active() || isRecording()) return;
    const btn = $('btn-mic-test');
    btn.disabled = true;
    $('mic-test-result').hidden = true;
    const label = btn.lastChild;
    const original = label.textContent;
    try {
      const { raw, processed } = await capture.testMic(5, (n) => { label.textContent = `Fale agora… ${n}`; });
      if (micTest) Object.values(micTest).forEach((u) => URL.revokeObjectURL(u));
      micTest = { raw: URL.createObjectURL(raw), processed: URL.createObjectURL(processed) };
      $('mic-test-result').hidden = false;
      playTest('processed');
    } catch {
      toast('Não foi possível testar o microfone.');
    } finally {
      label.textContent = original;
      btn.disabled = false;
    }
  }

  function playTest(which) {
    const a = $('mic-test-audio');
    a.pause();
    a.src = micTest[which];
    a.play().catch(() => {});
  }

  function stopTestAudio() {
    const a = $('mic-test-audio');
    a.pause();
    a.removeAttribute('src');
    a.load();
  }

  // ---------- Gravação ----------
  const isRecording = () => recorder?.state === 'recording';

  function startRecording() {
    const rec = capture.recording();
    const mimeType = pickMime('video');
    recChunks = [];
    recVertical = rec.vertical;
    recFps = rec.fps;
    recorder = new MediaRecorder(rec.stream, {
      ...(mimeType && { mimeType }),
      videoBitsPerSecond: rec.videoBitsPerSecond,
      audioBitsPerSecond: 128_000,
    });
    recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    recorder.onstop = showRecording;
    // Sem timeslice: um único bloco no fim, em vez de picos de trabalho a cada segundo.
    // O caminho do recorte conta do start() (t = 0 do arquivo); o 'onstart' chega atrasado
    // enquanto o codificador inicia, e o vídeo já cobre esse intervalo.
    recVertical?.begin();
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
    if (!$('av').hidden) renderAv();
  }

  function stopRecording() {
    clearInterval(recTimer);
    $('rec-badge').hidden = true;
    btnRec.classList.remove('on');
    btnRec.innerHTML = icon('video');
    if (recorder?.state !== 'inactive') recorder?.stop();
  }

  async function toggleRecording() {
    if (isRecording()) {
      stopRecording();
      pause();
      return;
    }
    if (!capture.active()) return;
    $('av').hidden = true;
    await capture.resumeAudio();
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
    recBlobs = { h: new Blob(recChunks, { type }) };
    recChunks = [];
    recorder = null;
    const path = recVertical?.end();
    recInfo = path && { points: path.length, first: Math.round(path[0]?.t ?? 0), last: Math.round(path.at(-1)?.t ?? 0) };
    recVertical = null;
    const dual = !!path;
    $('rec-formats').hidden = !dual;
    showFormat('h');
    const file = recFile();
    $('btn-rec-share').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    $('rec-result').hidden = false;
    if (dual) makeVertical(path, type);
    // Algo pedido durante a gravação (ex.: trocar microfone) fica para agora.
    else if (cameraMode && capture.needsRestart()) restartCamera();
  }

  /** Gera o vertical (9:16) a partir do horizontal + caminho do recorte. */
  async function makeVertical(path, type) {
    const tab = $('rec-tab-v');
    const label = $('rec-v-label');
    tab.disabled = true;
    label.textContent = 'Gerando 0%';
    const ctrl = new AbortController();
    renderAbort = ctrl;
    // Libera o aparelho: o preview ao vivo e a detecção param enquanto o vertical é gerado.
    capture.pauseReframe(true);
    try {
      const blob = await renderVertical(recBlobs.h, path, {
        fps: recFps,
        mimeType: pickMime('video') || type,
        signal: ctrl.signal,
        onProgress: (f) => { label.textContent = `Gerando ${Math.floor(f * 100)}%`; },
      });
      if (!blob || ctrl.signal.aborted) return;
      recBlobs.v = blob;
      label.textContent = 'Vertical';
      tab.disabled = false;
      toast('Vídeo vertical pronto.');
    } catch {
      if (!ctrl.signal.aborted) { label.textContent = 'Vertical (falhou)'; toast('Não foi possível gerar o vertical.'); }
    } finally {
      if (renderAbort === ctrl) renderAbort = null;
      capture.pauseReframe(false);
      if (!ctrl.signal.aborted && cameraMode && capture.needsRestart()) restartCamera();
    }
  }

  function showFormat(f) {
    if (!recBlobs[f]) return;
    recSel = f;
    const preview = $('rec-preview');
    preview.pause();
    if (preview.src) URL.revokeObjectURL(preview.src);
    preview.src = URL.createObjectURL(recBlobs[f]);
    $('rec-tab-h').classList.toggle('on', f === 'h');
    $('rec-tab-v').classList.toggle('on', f === 'v');
  }

  function recFile() {
    const blob = recBlobs[recSel];
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const suffix = $('rec-formats').hidden ? '' : recSel === 'v' ? '-vertical' : '-horizontal';
    return new File([blob], `teleprompter-${stamp}${suffix}.${ext}`, { type: blob.type });
  }

  function closeRecording() {
    renderAbort?.abort();
    renderAbort = null;
    const preview = $('rec-preview');
    preview.pause();
    if (preview.src) URL.revokeObjectURL(preview.src);
    preview.removeAttribute('src');
    preview.load(); // descarrega a mídia; sem isso o áudio segue tocando em segundo plano
    recBlobs = {};
    recSel = 'h';
    $('rec-result').hidden = true;
  }

  // Com dois formatos, salvar/compartilhar um não fecha a tela (falta o outro).
  const dualPending = () => !$('rec-formats').hidden;
  function saveRecording() {
    const file = recFile();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    if (dualPending()) {
      toast(`${recSel === 'v' ? 'Vertical' : 'Horizontal'} salvo em Downloads.`);
    } else {
      toast('Vídeo salvo em Downloads.');
      closeRecording();
    }
  }

  async function shareRecording() {
    try {
      await navigator.share({ files: [recFile()], title: 'Teleprompter' });
      if (!dualPending()) closeRecording();
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
    sheets.forEach((id) => { $(id).hidden = true; });
    closeRecording();
    lockScreen();
    applySettings();
    renderState();
    if (camera && !(await startCamera())) {
      btnRec.hidden = true;
      cameraMode = false;
      view.classList.remove('camera');
      layout();
    }
  }

  function close() {
    if (!active) return;
    if (isRecording()) {
      recorder.onstop = null;
      stopRecording();
      recVertical?.end();
      recVertical = null;
      recorder = null;
    }
    pause();
    cancelCountdown();
    stopTestAudio();
    stopCamera();
    closeRecording();
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    active = false;
    cameraMode = false;
  }

  return {
    open, close, applySettings, toggle, changeSpeed,
    restart: () => { pause(); cancelCountdown(); setPos(0); },
    toggleRecording, saveRecording, shareRecording, discardRecording: closeRecording, showFormat,
    isRecording,
    isCamera: () => cameraMode,
    openAv: () => { $('settings').hidden = true; $('av').hidden = false; renderAv(); },
    closeAv: () => { $('av').hidden = true; stopTestAudio(); },
    testMic,
    playTest,
    debug: () => ({ reframe: capture.reframeState(), size: capture.videoSize(), vertical: capture.isVertical(), level: capture.level(), rendering: !!renderAbort, formats: Object.keys(recBlobs), recInfo }),
  };
}
