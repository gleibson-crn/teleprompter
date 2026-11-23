package io.github.gleibsoncrn.teleprompter;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.DataOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Random;

/**
 * Tratamento de voz sem aparelho: sinais sintéticos (voz harmônica com sílabas e pausas + ruído).
 * Também grava amostras WAV (original / leve / forte) em build/voice-samples para ouvir.
 */
public class VoiceDspTest {

    /** "Voz": fundamental ~140 Hz com vibrato, harmônicos com formantes, sílabas de ~4 Hz e pausas. */
    static float[] voice(int sr, double seconds) {
        int len = (int) (sr * seconds);
        float[] x = new float[len];
        double ph = 0;
        for (int i = 0; i < len; i++) {
            double t = (double) i / sr;
            double f0 = 140 + 12 * Math.sin(2 * Math.PI * 5 * t) + 20 * Math.sin(2 * Math.PI * 0.3 * t);
            ph += 2 * Math.PI * f0 / sr;
            double s = 0;
            for (int k = 1; k <= 25; k++) {
                double f = f0 * k;
                double formant = Math.exp(-Math.pow((f - 600) / 300, 2)) + 0.6 * Math.exp(-Math.pow((f - 1700) / 400, 2))
                    + 0.3 * Math.exp(-Math.pow((f - 2800) / 500, 2)) + 0.05;
                s += formant * Math.sin(k * ph) / k;
            }
            x[i] = (float) (s * 0.05 * env(t));
        }
        return x;
    }

    /** Fala de 2 s, pausa de 1 s (as pausas medem o ruído que sobra). */
    static double env(double t) {
        double cyc = t % 3.0;
        if (cyc >= 2.0 || t < 0.5) return 0;
        double syl = 0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * cyc);
        return 0.3 + 0.7 * syl;
    }

    /** Ruído rosado aproximado (ambiente: ar-condicionado, rua). */
    static float[] noise(int len, double amp, long seed) {
        Random r = new Random(seed);
        float[] x = new float[len];
        double b0 = 0, b1 = 0, b2 = 0;
        for (int i = 0; i < len; i++) {
            double w = r.nextGaussian();
            b0 = 0.99765 * b0 + w * 0.0990460;
            b1 = 0.96300 * b1 + w * 0.2965164;
            b2 = 0.57000 * b2 + w * 1.0526913;
            x[i] = (float) ((b0 + b1 + b2 + w * 0.1848) * amp);
        }
        return x;
    }

    static float[] mix(float[] a, float[] b) {
        float[] y = new float[a.length];
        for (int i = 0; i < a.length; i++) y[i] = a[i] + b[i];
        return y;
    }

    /** Processa em blocos de tamanhos variados, como o Media3 entrega. */
    static float[] run(float[] in, int sr, int ch, int level) {
        VoiceDsp dsp = new VoiceDsp(sr, ch, level);
        VoiceDsp.FloatBuf out = new VoiceDsp.FloatBuf(in.length);
        Random r = new Random(7);
        int frames = in.length / ch;
        int pos = 0;
        while (pos < frames) {
            int n = Math.min(frames - pos, 100 + r.nextInt(3000));
            float[] blk = new float[n * ch];
            System.arraycopy(in, pos * ch, blk, 0, n * ch);
            for (float v : dsp.process(blk, n)) out.add(v);
            pos += n;
        }
        for (float v : dsp.flush()) out.add(v);
        return out.toArray();
    }

    static double rms(float[] x, int sr, boolean speech, int ch, int c) {
        double s = 0;
        int n = 0;
        for (int i = 0; i < x.length / ch; i++) {
            double t = (double) i / sr;
            double cyc = t % 3.0;
            boolean isPause = t > 1.0 && cyc > 2.2 && cyc < 2.9; // miolo da pausa
            boolean isSpeech = t > 1.0 && cyc > 0.2 && cyc < 1.8;
            if (speech ? isSpeech : isPause) { s += x[i * ch + c] * x[i * ch + c]; n++; }
        }
        return Math.sqrt(s / Math.max(1, n));
    }

    static double db(double v) { return 20 * Math.log10(v + 1e-12); }

    @Test
    public void tamanhoPicoESemNaN_44e48kHz_monoEEstereo() {
        for (int sr : new int[] { 44100, 48000, 16000 }) {
            for (int ch : new int[] { 1, 2 }) {
                float[] mono = mix(voice(sr, 6), noise((int) (sr * 6.0), 0.01, sr));
                float[] in = new float[mono.length * ch];
                for (int i = 0; i < mono.length; i++) for (int c = 0; c < ch; c++) in[i * ch + c] = mono[i];
                for (int level : new int[] { VoiceDsp.LEVE, VoiceDsp.FORTE }) {
                    float[] out = run(in, sr, ch, level);
                    assertEquals("tamanho preservado sr=" + sr + " ch=" + ch, in.length, out.length);
                    for (float v : out) {
                        assertTrue("sem NaN", !Float.isNaN(v) && !Float.isInfinite(v));
                        assertTrue("pico ≤ −1 dBFS", Math.abs(v) <= 0.8901f);
                    }
                }
            }
        }
    }

    @Test
    public void reduzRuidoSemPassarDoPiso() {
        int sr = 48000;
        float[] v = voice(sr, 12);
        float[] in = mix(v, noise(v.length, 0.004, 1));
        double snrIn = db(rms(in, sr, true, 1, 0)) - db(rms(in, sr, false, 1, 0));
        double[] floors = { 0, -12, -18 };
        for (int level : new int[] { VoiceDsp.LEVE, VoiceDsp.FORTE }) {
            VoiceDsp dsp = new VoiceDsp(sr, 1, level);
            float[] out = dsp.process(in, in.length);
            float[] tail = dsp.flush();
            float[] all = new float[out.length + tail.length];
            System.arraycopy(out, 0, all, 0, out.length);
            System.arraycopy(tail, 0, all, out.length, tail.length);
            double snrOut = db(rms(all, sr, true, 1, 0)) - db(rms(all, sr, false, 1, 0));
            System.out.printf("nível %d: SNR %.1f dB → %.1f dB; ganho mínimo %.1f dB%n", level, snrIn, snrOut, db(dsp.minGain()));
            assertTrue("melhora o SNR em ≥ 6 dB (nível " + level + "): " + snrIn + " → " + snrOut, snrOut - snrIn >= 6);
            assertTrue("nunca abaixo do piso", db(dsp.minGain()) >= floors[level] - 0.01);
        }
    }

    @Test
    public void semAtrasoNoAudio() {
        int sr = 48000;
        float[] in = mix(voice(sr, 6), noise(sr * 6, 0.003, 3));
        float[] out = run(in, sr, 1, VoiceDsp.LEVE);
        // correlação cruzada no trecho de fala: o pico tem de estar no deslocamento 0
        int from = (int) (sr * 3.2);
        int to = (int) (sr * 4.8);
        int bestLag = 0;
        double best = -1e30;
        for (int lag = -300; lag <= 300; lag++) {
            double s = 0;
            for (int i = from; i < to; i++) s += in[i] * out[i + lag];
            if (s > best) { best = s; bestLag = lag; }
        }
        assertTrue("sincronia: deslocamento " + bestLag + " amostras", Math.abs(bestLag) <= 2);
    }

    @Test
    public void cortaGraveAbaixoDe80Hz() {
        int sr = 48000;
        int len = sr * 3;
        float[] lo = new float[len];
        float[] hi = new float[len];
        for (int i = 0; i < len; i++) {
            lo[i] = (float) (0.05 * Math.sin(2 * Math.PI * 40 * i / sr));
            hi[i] = (float) (0.05 * Math.sin(2 * Math.PI * 1000 * i / sr));
        }
        float[] a = run(lo, sr, 1, VoiceDsp.LEVE);
        float[] b = run(hi, sr, 1, VoiceDsp.LEVE);
        double ra = 0, rb = 0;
        for (int i = sr; i < len; i++) { ra += a[i] * a[i]; rb += b[i] * b[i]; }
        double diff = 10 * Math.log10(rb / Math.max(ra, 1e-20));
        assertTrue("40 Hz cai ≥ 10 dB em relação a 1 kHz: " + diff, diff >= 10);
    }

    @Test
    public void gravaAmostrasParaOuvir() throws IOException {
        int sr = 48000;
        float[] v = voice(sr, 12);
        float[] in = mix(v, noise(v.length, 0.004, 1));
        File dir = new File("build/voice-samples");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        wav(new File(dir, "1-original.wav"), in, sr);
        wav(new File(dir, "2-leve.wav"), run(in, sr, 1, VoiceDsp.LEVE), sr);
        wav(new File(dir, "3-forte.wav"), run(in, sr, 1, VoiceDsp.FORTE), sr);
        assertTrue(new File(dir, "2-leve.wav").length() > 44);
    }

    static void wav(File f, float[] x, int sr) throws IOException {
        try (DataOutputStream o = new DataOutputStream(new FileOutputStream(f))) {
            int data = x.length * 2;
            o.writeBytes("RIFF");
            o.writeInt(Integer.reverseBytes(36 + data));
            o.writeBytes("WAVEfmt ");
            o.writeInt(Integer.reverseBytes(16));
            o.writeShort(Short.reverseBytes((short) 1));
            o.writeShort(Short.reverseBytes((short) 1));
            o.writeInt(Integer.reverseBytes(sr));
            o.writeInt(Integer.reverseBytes(sr * 2));
            o.writeShort(Short.reverseBytes((short) 2));
            o.writeShort(Short.reverseBytes((short) 16));
            o.writeBytes("data");
            o.writeInt(Integer.reverseBytes(data));
            for (float v : x) o.writeShort(Short.reverseBytes((short) Math.max(-32768, Math.min(32767, Math.round(v * 32767)))));
        }
    }
}
