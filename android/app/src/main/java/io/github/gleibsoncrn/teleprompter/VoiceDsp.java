package io.github.gleibsoncrn.teleprompter;

/**
 * Tratamento de voz (Java puro, sem Android: testável no JUnit).
 *
 * Cadeia por canal: passa-altas 80 Hz → redução de ruído (Wiener por STFT) → compressor → limitador.
 *
 * A redução de ruído foi desenhada para NÃO robotizar a voz (o "musical noise" que os redutores
 * agressivos deixam):
 *  - ruído estimado pelo mínimo do espectro suavizado (acompanha o fundo, ignora a voz);
 *  - SNR a priori "decision-directed" (alfa 0,95), que muda devagar de um quadro para o outro;
 *  - ganho suavizado entre bandas vizinhas;
 *  - PISO de ganho: nenhuma banda cai mais que 12 dB (Leve) ou 18 dB (Forte) — nunca zera.
 *
 * Saída tem exatamente o mesmo número de amostras da entrada, sem atraso (a latência da STFT é
 * descontada), para manter a sincronia com o vídeo.
 */
final class VoiceDsp {

    static final int OFF = 0;
    static final int LEVE = 1;
    static final int FORTE = 2;
    // Ajuste pela varredura do VoiceDspTest: melhor troca entre ruído que some e voz preservada.
    static final double ALPHA = 0.95;

    static int parseLevel(String s) {
        if ("forte".equals(s)) return FORTE;
        if ("leve".equals(s)) return LEVE;
        return OFF;
    }

    private final int channels;
    private final Chan[] chans;
    private final int n;
    private final int hop;
    private final int latency;
    private long inCount = 0;   // amostras por canal recebidas
    private long outCount = 0;  // amostras por canal entregues
    private long dropLeft;      // amostras iniciais a descartar (latência)

    VoiceDsp(int sampleRate, int channels, int level) {
        this(sampleRate, channels, level, ALPHA, true, -1);
    }

    /** Para o teste: alfa do decision-directed, compressor liga/desliga, superestimação (−1 = padrão). */
    VoiceDsp(int sampleRate, int channels, int level, double alpha, boolean dynamics, double overEst) {
        if (level == OFF) throw new IllegalArgumentException("nível desligado não processa");
        this.channels = channels;
        n = sampleRate >= 32000 ? 1024 : 512;
        hop = n / 4;
        latency = n - hop;
        dropLeft = latency;
        chans = new Chan[channels];
        for (int c = 0; c < channels; c++) chans[c] = new Chan(sampleRate, n, level, alpha, dynamics, overEst);
    }

    /** Ganho mínimo aplicado até agora (para teste: nunca abaixo do piso). */
    double minGain() {
        double m = 1;
        for (Chan c : chans) m = Math.min(m, c.minGainSeen);
        return m;
    }

    /**
     * Processa amostras intercaladas (float −1..1). Devolve as amostras prontas (intercaladas),
     * que podem ser menos que as de entrada no começo (latência), compensadas em {@link #flush()}.
     */
    float[] process(float[] in, int frames) {
        inCount += frames;
        FloatBuf out = new FloatBuf(frames * channels + hop * channels);
        float[][] ready = new float[channels][];
        int[] readyLen = new int[channels];
        for (int c = 0; c < channels; c++) {
            Chan ch = chans[c];
            ch.outTmp.clear();
            for (int i = 0; i < frames; i++) ch.push(in[i * channels + c]);
            ready[c] = ch.outTmp.data;
            readyLen[c] = ch.outTmp.size;
        }
        emit(ready, readyLen[0], out);
        return out.toArray();
    }

    /** Fim do fluxo: empurra zeros para sair o resto e corta no tamanho exato da entrada. */
    float[] flush() {
        FloatBuf out = new FloatBuf((latency + hop) * channels);
        float[][] ready = new float[channels][];
        int len = 0;
        for (int c = 0; c < channels; c++) {
            Chan ch = chans[c];
            ch.outTmp.clear();
            for (int i = 0; i < latency + hop; i++) ch.push(0f);
            ready[c] = ch.outTmp.data;
            len = ch.outTmp.size;
        }
        emit(ready, len, out);
        return out.toArray();
    }

    private void emit(float[][] ready, int len, FloatBuf out) {
        for (int i = 0; i < len; i++) {
            if (dropLeft > 0) { dropLeft--; continue; }
            if (outCount >= inCount) break;
            for (int c = 0; c < channels; c++) out.add(ready[c][i]);
            outCount++;
        }
    }

    // ------------------------------------------------------------------ canal

    private static final class Chan {
        final int n;
        final int hop;
        final int bins;
        final float[] win;
        final float[] inBuf;
        int fill = 0;
        final float[] ola;
        final double[] re;
        final double[] im;
        final double[] smooth;
        final double[] noise;
        final double[] minS;
        final double[] gPrev;
        final double[] gammaPrev;
        final double[] gain;
        int frames = 0; // os 4 primeiros quadros só enchem a janela: ruído = espectro atual
        final double floor;
        final double over;
        final double rise;
        double minGainSeen = 1;
        final FloatBuf outTmp = new FloatBuf(4096);

        // passa-altas (biquad Butterworth 2ª ordem, 80 Hz)
        final double b0, b1, b2, a1, a2;
        double x1, x2, y1, y2;

        // compressor + limitador
        final double atk, rel, limRel;
        double env = 0;
        double limGain = 1;
        static final double THRESH_DB = -24;
        static final double RATIO = 3;
        static final double MAKEUP_DB = 6;
        static final double CEIL = 0.89; // −1 dBFS

        final double alpha;
        final boolean dynamics;

        Chan(int sr, int n, int level, double alpha, boolean dynamics, double overEst) {
            this.alpha = alpha;
            this.dynamics = dynamics;
            this.n = n;
            hop = n / 4;
            bins = n / 2 + 1;
            win = new float[n];
            for (int i = 0; i < n; i++) win[i] = (float) (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
            inBuf = new float[n];
            ola = new float[n];
            re = new double[n];
            im = new double[n];
            smooth = new double[bins];
            noise = new double[bins];
            minS = new double[bins];
            gPrev = new double[bins];
            gammaPrev = new double[bins];
            gain = new double[bins];
            java.util.Arrays.fill(gPrev, 1);
            java.util.Arrays.fill(gammaPrev, 1);
            floor = Math.pow(10, (level == FORTE ? -18 : -12) / 20.0);
            over = overEst > 0 ? overEst : level == FORTE ? 1.1 : 0.8;
            // o ruído estimado sobe no máximo ~3 dB/s (o mínimo segue o fundo, não a voz)
            rise = Math.pow(10, 3.0 / 10.0 * hop / sr);

            double w0 = 2 * Math.PI * 80 / sr;
            double q = Math.sin(w0) / (2 * Math.sqrt(0.5));
            double cos = Math.cos(w0);
            double a0 = 1 + q;
            b0 = (1 + cos) / 2 / a0;
            b1 = -(1 + cos) / a0;
            b2 = (1 + cos) / 2 / a0;
            a1 = -2 * cos / a0;
            a2 = (1 - q) / a0;

            atk = Math.exp(-1 / (0.010 * sr));
            rel = Math.exp(-1 / (0.150 * sr));
            limRel = Math.exp(-1 / (0.050 * sr));
        }

        void push(float x) {
            double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1; x1 = x; y2 = y1; y1 = y;
            inBuf[n - hop + fill] = (float) y;
            if (++fill == hop) {
                frame();
                fill = 0;
            }
        }

        private void frame() {
            for (int i = 0; i < n; i++) { re[i] = inBuf[i] * win[i]; im[i] = 0; }
            fft(re, im, false);
            for (int k = 0; k < bins; k++) {
                double p = re[k] * re[k] + im[k] * im[k];
                // Ruído = MÉDIA do espectro nos trechos sem voz (onde a potência fica perto do
                // ruído atual), com um piso vindo do mínimo do espectro suavizado — que só
                // sobe devagar e destrava a estimativa se o fundo aumentar (ar-condicionado ligou).
                boolean init = frames < 4;
                smooth[k] = frames == 0 ? p : 0.9 * smooth[k] + 0.1 * p;
                if (init) { noise[k] = smooth[k]; minS[k] = smooth[k]; }
                else {
                    minS[k] = smooth[k] < minS[k] ? smooth[k] : Math.min(minS[k] * rise, smooth[k]);
                    if (p < 3 * noise[k]) noise[k] = 0.95 * noise[k] + 0.05 * p;
                    noise[k] = Math.max(noise[k], 1.5 * minS[k]);
                }
                double nz = Math.max(noise[k] * over, 1e-12);
                double gamma = p / nz;
                double xi = alpha * gPrev[k] * gPrev[k] * gammaPrev[k] + (1 - alpha) * Math.max(gamma - 1, 0);
                xi = Math.max(xi, 1e-3);
                double g = xi / (1 + xi);
                gain[k] = g;
                gammaPrev[k] = Math.min(gamma, 1e4);
            }
            frames++;
            for (int k = 0; k < bins; k++) {
                double g = gain[k];
                double gl = k > 0 ? gain[k - 1] : g;
                double gr = k < bins - 1 ? gain[k + 1] : g;
                double gs = Math.max(0.25 * gl + 0.5 * g + 0.25 * gr, floor);
                gPrev[k] = gs;
                if (gs < minGainSeen) minGainSeen = gs;
                re[k] *= gs;
                im[k] *= gs;
                if (k > 0 && k < n / 2) { re[n - k] *= gs; im[n - k] *= gs; }
            }
            fft(re, im, true);
            // Hann na análise e na síntese com 75% de sobreposição: soma das janelas² = 1,5.
            for (int i = 0; i < n; i++) ola[i] += (float) (re[i] * win[i] / 1.5);
            for (int i = 0; i < hop; i++) outTmp.add(dynamics ? dyn(ola[i]) : ola[i]);
            System.arraycopy(ola, hop, ola, 0, n - hop);
            java.util.Arrays.fill(ola, n - hop, n, 0f);
            System.arraycopy(inBuf, hop, inBuf, 0, n - hop);
        }

        /** Compressor suave (3:1 acima de −24 dBFS, +6 dB) e limitador em −1 dBFS. */
        private float dyn(float x) {
            double a = Math.abs(x);
            env = a > env ? atk * env + (1 - atk) * a : rel * env + (1 - rel) * a;
            double lvl = 20 * Math.log10(env + 1e-9);
            double over = lvl - THRESH_DB;
            double gr = over > 0 ? over * (1 - 1 / RATIO) : 0;
            double y = x * Math.pow(10, (MAKEUP_DB - gr) / 20);
            double ay = Math.abs(y);
            double need = ay > CEIL ? CEIL / ay : 1;
            limGain = need < limGain ? need : limRel * limGain + (1 - limRel);
            y *= limGain;
            if (y > CEIL) y = CEIL;
            if (y < -CEIL) y = -CEIL;
            return (float) y;
        }
    }

    /** FFT complexa radix-2 in-place (inverse = true já divide por n). */
    static void fft(double[] re, double[] im, boolean inverse) {
        int n = re.length;
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                double t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (int len = 2; len <= n; len <<= 1) {
            double ang = 2 * Math.PI / len * (inverse ? 1 : -1);
            double wr = Math.cos(ang);
            double wi = Math.sin(ang);
            for (int i = 0; i < n; i += len) {
                double cr = 1;
                double ci = 0;
                for (int k = 0; k < len / 2; k++) {
                    int a = i + k;
                    int b = a + len / 2;
                    double xr = re[b] * cr - im[b] * ci;
                    double xi = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - xr;
                    im[b] = im[a] - xi;
                    re[a] += xr;
                    im[a] += xi;
                    double t = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = t;
                }
            }
        }
        if (inverse) for (int i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }

    /** Lista de float que cresce sozinha (evita boxing). */
    static final class FloatBuf {
        float[] data;
        int size;
        FloatBuf(int cap) { data = new float[Math.max(16, cap)]; }
        void add(float v) {
            if (size == data.length) data = java.util.Arrays.copyOf(data, data.length * 2);
            data[size++] = v;
        }
        void clear() { size = 0; }
        float[] toArray() { return java.util.Arrays.copyOf(data, size); }
    }
}
