// Cadeia de áudio (Web Audio): microfone → [filtro de grave → presença → compressor]
// (só no modo Voz) → ganho → noise gate → limitador → saída gravável.
// Tudo nativo do navegador; nada sai do aparelho.

const GATE_THRESHOLD_DB = -50; // abaixo disso, nas pausas, o fundo é atenuado
const GATE_FLOOR = 0.12;       // ~-18 dB: atenua sem "cortar" de forma artificial
const GATE_HOLD_MS = 250;

/** Constraints do getUserMedia para o microfone escolhido. */
export function audioConstraints(s) {
  const voz = s.audioMode !== 'cru';
  return {
    ...(s.micId && { deviceId: { exact: s.micId } }),
    // Sem alto-falante tocando, o cancelamento de eco só piora a voz; a cadeia faz o resto.
    echoCancellation: false,
    noiseSuppression: voz,
    autoGainControl: false,
    channelCount: { ideal: 1 },
  };
}

export async function listMics() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

const dbToGain = (db) => 10 ** (db / 20);

export function createAudioChain(inputStream, settings) {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const source = ctx.createMediaStreamSource(inputStream);

  const highpass = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 85, Q: 0.7 });
  const presence = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 3500, Q: 0.9, gain: 3 });
  const compressor = new DynamicsCompressorNode(ctx, { threshold: -24, knee: 12, ratio: 3, attack: 0.005, release: 0.2 });
  const gain = new GainNode(ctx, { gain: 1 });
  const gate = new GainNode(ctx, { gain: 1 });
  const limiter = new DynamicsCompressorNode(ctx, { threshold: -1.5, knee: 0, ratio: 20, attack: 0.001, release: 0.08 });
  const out = ctx.createMediaStreamDestination();

  // Medidores: antes do gate (decide abrir/fechar) e na saída (o que vai para o vídeo).
  const preMeter = new AnalyserNode(ctx, { fftSize: 1024 });
  const outMeter = new AnalyserNode(ctx, { fftSize: 1024 });
  // Saída "crua" para o teste A/B do microfone.
  const rawOut = ctx.createMediaStreamDestination();
  source.connect(rawOut);

  gain.connect(preMeter);
  gain.connect(gate).connect(limiter);
  limiter.connect(out);
  limiter.connect(outMeter);

  let current = {};
  function apply(s) {
    const voz = s.audioMode !== 'cru';
    if (voz !== current.voz) {
      source.disconnect();
      highpass.disconnect();
      presence.disconnect();
      compressor.disconnect();
      source.connect(rawOut);
      if (voz) source.connect(highpass).connect(presence).connect(compressor).connect(gain);
      else source.connect(gain);
    }
    gain.gain.setTargetAtTime(dbToGain(s.gainDb || 0), ctx.currentTime, 0.05);
    if (!s.gate) gate.gain.setTargetAtTime(1, ctx.currentTime, 0.02);
    current = { voz, gate: !!s.gate };
  }
  apply(settings);

  // Noise gate leve no thread principal (50 Hz basta para voz).
  const buf = new Float32Array(preMeter.fftSize);
  let open = true;
  let lastLoud = 0;
  const gateTimer = setInterval(() => {
    if (!current.gate) return;
    preMeter.getFloatTimeDomainData(buf);
    const loud = rmsDb(buf) > GATE_THRESHOLD_DB;
    const now = performance.now();
    if (loud) lastLoud = now;
    const shouldOpen = loud || now - lastLoud < GATE_HOLD_MS;
    if (shouldOpen !== open) {
      open = shouldOpen;
      gate.gain.setTargetAtTime(open ? 1 : GATE_FLOOR, ctx.currentTime, open ? 0.005 : 0.08);
    }
  }, 20);

  const meterBuf = new Float32Array(outMeter.fftSize);
  /** Nível atual da saída: { rms, peak } em dBFS. */
  function level() {
    outMeter.getFloatTimeDomainData(meterBuf);
    let peak = 0;
    for (const v of meterBuf) peak = Math.max(peak, Math.abs(v));
    return { rms: rmsDb(meterBuf), peak: 20 * Math.log10(peak || 1e-6) };
  }

  return {
    stream: out.stream,
    rawStream: rawOut.stream,
    apply,
    level,
    resume: () => ctx.state === 'suspended' ? ctx.resume() : Promise.resolve(),
    close() {
      clearInterval(gateTimer);
      ctx.close().catch(() => {});
    },
  };
}

function rmsDb(buf) {
  let sum = 0;
  for (const v of buf) sum += v * v;
  return 10 * Math.log10(sum / buf.length || 1e-12);
}
