// Diagnóstico de gravação: grava alguns segundos com os ajustes atuais (sem salvar) e mede
// onde está o gargalo — codificador (hardware × software), câmera, quadros perdidos e
// travadas da tela. Gera um texto para o usuário copiar e mandar.
import { pickMime } from './capture.js';

const VIDEO_CODECS = [
  // [rótulo, contentType p/ MediaCapabilities (tipo 'webrtc': o Chrome não aceita 'record'), codec p/ WebCodecs]
  ['H.264', 'video/H264;profile-level-id=42e01f', 'avc1.640028'],
  ['VP8', 'video/VP8', 'vp8'],
  ['VP9', 'video/VP9', 'vp09.00.10.08'],
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Quadros do vídeo lidos direto do MP4 (sem tocar): conta as amostras da trilha de vídeo e
 * acha o maior intervalo entre quadros. Entende MP4 comum (stts) e fragmentado (moof/trun),
 * que é o que o MediaRecorder do Chrome gera. Retorna null se não for MP4.
 */
export function mp4VideoFrames(buf) {
  const dv = new DataView(buf);
  const type = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex']);
  const tracks = new Map(); // id → { video, timescale, trexDur }
  let cur = null; // trak em leitura
  let durs = []; // durações (unidades do timescale) das amostras de vídeo
  let videoId = null;
  let traf = null;
  function walk(start, end) {
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o);
      const t = type(o + 4);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      const b = o + hdr; // início do conteúdo
      if (t === 'trak') { cur = {}; walk(b, o + size); if (cur.id != null) tracks.set(cur.id, cur); if (cur.video) videoId = cur.id; cur = null; }
      else if (t === 'traf') { traf = {}; walk(b, o + size); traf = null; }
      else if (CONTAINERS.has(t)) walk(b, o + size);
      else if (t === 'tkhd' && cur) cur.id = dv.getUint32(b + (dv.getUint8(b) === 1 ? 20 : 12));
      else if (t === 'hdlr' && cur) cur.video = type(b + 8) === 'vide';
      else if (t === 'mdhd' && cur) cur.timescale = dv.getUint32(b + (dv.getUint8(b) === 1 ? 20 : 12));
      else if (t === 'stts') {
        // stts vem depois do hdlr dentro do trak: só a trilha de vídeo interessa
        if (cur?.video) {
          const n = dv.getUint32(b + 4);
          for (let i = 0; i < n; i++) {
            const count = dv.getUint32(b + 8 + i * 8);
            const delta = dv.getUint32(b + 12 + i * 8);
            for (let k = 0; k < count; k++) durs.push(delta);
          }
        }
      } else if (t === 'trex') {
        const id = dv.getUint32(b + 4);
        const tr = tracks.get(id);
        if (tr) tr.trexDur = dv.getUint32(b + 12);
      } else if (t === 'tfhd' && traf) {
        const flags = dv.getUint32(b) & 0xffffff;
        traf.id = dv.getUint32(b + 4);
        let p = b + 8;
        if (flags & 0x01) p += 8;
        if (flags & 0x02) p += 4;
        traf.defDur = flags & 0x08 ? dv.getUint32(p) : tracks.get(traf.id)?.trexDur;
      } else if (t === 'trun' && traf && traf.id === videoId) {
        const flags = dv.getUint32(b) & 0xffffff;
        const n = dv.getUint32(b + 4);
        let p = b + 8;
        if (flags & 0x01) p += 4;
        if (flags & 0x04) p += 4;
        for (let i = 0; i < n; i++) {
          let d = traf.defDur ?? 0;
          if (flags & 0x100) { d = dv.getUint32(p); p += 4; }
          if (flags & 0x200) p += 4;
          if (flags & 0x400) p += 4;
          if (flags & 0x800) p += 4;
          durs.push(d);
        }
      }
      o += size;
    }
  }
  try {
    if (type(4) !== 'ftyp') return null;
    walk(0, buf.byteLength);
  } catch { return null; }
  const ts = tracks.get(videoId)?.timescale;
  if (!ts || !durs.length) return null;
  // A última amostra pode vir com duração 0/indefinida: ignora no maior intervalo.
  const body = durs.slice(0, -1);
  const total = durs.reduce((s, d) => s + d, 0) / ts;
  return { frames: durs.length, seconds: total, gapMaxMs: Math.round((Math.max(0, ...body) / ts) * 1000) };
}

/** Quadros que existem de fato no arquivo (tocando-o escondido e contando os quadros novos). */
async function countFileFrames(blob, seconds) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(v);
  const url = URL.createObjectURL(blob);
  try {
    v.src = url;
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; });
    if (!('requestVideoFrameCallback' in v)) return null;
    const times = new Set();
    let gapMax = 0;
    let lastT = null;
    const onFrame = (_, m) => {
      if (!times.has(m.mediaTime)) {
        if (lastT !== null) gapMax = Math.max(gapMax, m.mediaTime - lastT);
        lastT = m.mediaTime;
        times.add(m.mediaTime);
      }
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
    const ended = new Promise((r) => { v.onended = r; });
    await v.play();
    await Promise.race([ended, wait((seconds + 3) * 1000)]);
    const q = v.getVideoPlaybackQuality?.();
    return { frames: times.size, gapMaxMs: Math.round(gapMax * 1000), playbackDropped: q?.droppedVideoFrames ?? null };
  } catch {
    return null;
  } finally {
    v.removeAttribute('src');
    v.load();
    v.remove();
    URL.revokeObjectURL(url);
  }
}

export async function runDiagnostics({ capture, video, settings, seconds = 8, onStatus = () => {} }) {
  const out = [];
  const add = (k, v) => out.push(`${k}: ${v}`);
  onStatus('Preparando…');

  // ---------- Aparelho ----------
  let model = '';
  try {
    const h = await navigator.userAgentData?.getHighEntropyValues(['model', 'platformVersion']);
    model = [h?.model, h?.platformVersion && `Android ${h.platformVersion}`].filter(Boolean).join(' · ');
  } catch { /* sem dados */ }
  add('Aparelho', model || navigator.userAgent);
  add('Navegador', navigator.userAgentData?.brands?.filter((b) => !/Not/.test(b.brand)).map((b) => `${b.brand} ${b.version}`).join(', ') || '-');
  add('Aberto como app instalado', matchMedia('(display-mode: standalone)').matches ? 'sim' : 'não');
  add('CPU / memória', `${navigator.hardwareConcurrency ?? '?'} núcleos · ${navigator.deviceMemory ?? '?'} GB`);
  add('Ajustes', `${settings.vertical ? '1080p (Vertical inteligente)' : `${settings.res}p`} · ${settings.fps} fps · seguir ${settings.follow ? 'sim' : 'não'} · áudio ${settings.audioMode}${settings.gate ? ' + gate' : ''}`);

  // ---------- Câmera e codificador ----------
  const rec = capture.recording();
  const vt = rec.stream.getVideoTracks()[0];
  const st = vt.getSettings();
  const fps = st.frameRate || settings.fps;
  add('Câmera entrega', `${st.width}×${st.height} @ ${round1(fps)} fps (preview ${video.videoWidth}×${video.videoHeight})`);
  const mime = pickMime('video');
  add('Formato de gravação', mime || '(padrão do navegador)');

  const enc = [];
  for (const [label, contentType, codec] of VIDEO_CODECS) {
    let mc = '';
    try {
      const r = await navigator.mediaCapabilities?.encodingInfo({
        type: 'webrtc',
        video: { contentType, width: st.width, height: st.height, bitrate: rec.videoBitsPerSecond, framerate: fps },
      });
      if (r) mc = r.supported ? `${r.powerEfficient ? 'HARDWARE' : 'software'}${r.smooth ? '' : ', não fluido'}` : 'não suportado';
    } catch { mc = '?'; }
    let wc = '';
    try {
      const r = await window.VideoEncoder?.isConfigSupported({ codec, width: st.width, height: st.height, bitrate: rec.videoBitsPerSecond, framerate: fps, hardwareAcceleration: 'prefer-hardware' });
      if (r) wc = r.supported ? 'hw ok' : 'sem hw';
    } catch { wc = '?'; }
    enc.push(`${label} ${[mc, wc && `WebCodecs ${wc}`].filter(Boolean).join(' / ')}`);
  }
  add('Codificadores', enc.join(' · '));

  // ---------- Gravação de teste ----------
  const snap = () => (vt.stats ? { d: vt.stats.deliveredFrames, x: vt.stats.discardedFrames, t: vt.stats.totalFrames } : null);
  let longCount = 0;
  let longSum = 0;
  let longMax = 0;
  let po = null;
  try {
    po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { longCount++; longSum += e.duration; longMax = Math.max(longMax, e.duration); }
    });
    po.observe({ type: 'longtask' });
  } catch { po = null; }
  let rafFrames = 0;
  let rafGapMax = 0;
  let rafLast = 0;
  let rafOn = true;
  const raf = (t) => { if (rafLast) rafGapMax = Math.max(rafGapMax, t - rafLast); rafLast = t; rafFrames++; if (rafOn) requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  const rfFps = [];

  const chunks = [];
  const recorder = new MediaRecorder(rec.stream, {
    ...(mime && { mimeType: mime }),
    videoBitsPerSecond: rec.videoBitsPerSecond,
    audioBitsPerSecond: 128_000,
  });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => { recorder.onstop = r; });
  const s0 = snap();
  const t0 = performance.now();
  recorder.start();
  for (let i = seconds; i > 0; i--) {
    onStatus(`Gravando teste… ${i}`);
    await wait(1000);
    const rf = capture.reframeState();
    if (rf?.fps) rfFps.push(rf.fps);
  }
  recorder.stop();
  await stopped;
  const elapsed = (performance.now() - t0) / 1000;
  const s1 = snap();
  rafOn = false;
  po?.disconnect();

  if (s0 && s1) {
    const deliv = s1.d - s0.d;
    const disc = s1.x - s0.x;
    add('Quadros da câmera', `${deliv} entregues (${round1(deliv / elapsed)} fps) · ${disc} descartados`);
  } else {
    add('Quadros da câmera', 'navegador não informa');
  }
  add('Tela (UI)', `${round1(rafFrames / elapsed)} fps · maior travada ${Math.round(rafGapMax)} ms`);
  add('Travadas longas (>50 ms)', po ? `${longCount} · total ${Math.round(longSum)} ms (${Math.round((longSum / (elapsed * 1000)) * 100)}% do tempo) · maior ${Math.round(longMax)} ms` : 'navegador não informa');
  if (rfFps.length) {
    const rf = capture.reframeState();
    add('Vertical inteligente', `preview ${Math.min(...rfFps)}–${Math.max(...rfFps)} fps · detector ${rf.engine || '-'} · ${rf.detectMs} ms`);
  }

  const blob = new Blob(chunks, { type: recorder.mimeType || mime });
  add('Arquivo', `${(blob.size / 1e6).toFixed(1)} MB · ${blob.type || '?'} · ${(blob.size * 8 / elapsed / 1e6).toFixed(1)} Mbps (pedido ${(rec.videoBitsPerSecond / 1e6).toFixed(1)})`);
  onStatus('Analisando o arquivo…');
  const mp4 = mp4VideoFrames(await blob.arrayBuffer());
  if (mp4) {
    add('Quadros no arquivo', `${mp4.frames} em ${round1(mp4.seconds)} s = ${round1(mp4.frames / mp4.seconds)} fps (esperado ${round1(fps)}) · maior buraco ${mp4.gapMaxMs} ms`);
  } else {
    const ff = await countFileFrames(blob, elapsed);
    if (ff) add('Quadros no arquivo (estimado tocando)', `${ff.frames} em ${round1(elapsed)} s = ${round1(ff.frames / elapsed)} fps (esperado ${round1(fps)}) · maior buraco ${ff.gapMaxMs} ms`);
  }
  return `Diagnóstico Teleprompter (${new Date().toLocaleString('pt-BR')})\n${out.join('\n')}`;
}
