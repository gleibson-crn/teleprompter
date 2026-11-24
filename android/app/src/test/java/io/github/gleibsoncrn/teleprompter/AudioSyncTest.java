package io.github.gleibsoncrn.teleprompter;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Sincronia lapela × câmera: a mesma voz chega aos dois microfones com atraso conhecido,
 * taxas diferentes (câmera 44,1 kHz, lapela 48 kHz), ruídos diferentes e timbres diferentes
 * (o do celular, longe, abafado e com mais ambiente).
 */
public class AudioSyncTest {

    /** "Voz" gerada no tempo contínuo: dá para amostrar em qualquer taxa com qualquer atraso. */
    static float[] voiceAt(int rate, double seconds, double delaySec, double gain) {
        int n = (int) (rate * seconds);
        float[] x = new float[n];
        for (int i = 0; i < n; i++) {
            double t = (double) i / rate - delaySec;
            if (t < 0) continue;
            double ph = 2 * Math.PI * (140 * t - 12 / (2 * Math.PI * 5) * Math.cos(2 * Math.PI * 5 * t)
                - 20 / (2 * Math.PI * 0.3) * Math.cos(2 * Math.PI * 0.3 * t));
            double s = 0;
            for (int k = 1; k <= 12; k++) s += Math.sin(k * ph) / k;
            x[i] = (float) (gain * s * VoiceDspTest.env(t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 1.3 * t)));
        }
        return x;
    }

    static float[] lowpass(float[] x, double a) {
        float[] y = new float[x.length];
        double s = 0;
        for (int i = 0; i < x.length; i++) { s += a * (x[i] - s); y[i] = (float) s; }
        return y;
    }

    void check(int lagMs, int searchLo, int searchHi) {
        // câmera (celular): começa em t=0, abafada, voz mais baixa e mais ruído
        float[] cam = VoiceDspTest.mix(lowpass(voiceAt(44100, 20, 0, 0.02), 0.2), VoiceDspTest.noise(44100 * 20, 0.004, 11));
        // lapela: começou a gravar lagMs ANTES da câmera → a mesma voz aparece lagMs depois
        float[] ext = VoiceDspTest.mix(voiceAt(48000, 20 + lagMs / 1000.0 + 1, lagMs / 1000.0, 0.08),
            VoiceDspTest.noise((int) (48000 * (21 + lagMs / 1000.0)), 0.001, 12));
        AudioSync.Result r = AudioSync.findLag(AudioSync.envelope(cam, 44100), AudioSync.envelope(ext, 48000), searchLo, searchHi);
        System.out.printf("atraso real %d ms → achado %d ms (correlação %.2f)%n", lagMs, r.lagMs, r.corr);
        assertTrue("achou o atraso " + lagMs + " ms: " + r.lagMs, Math.abs(r.lagMs - lagMs) <= 4);
        assertTrue("correlação alta: " + r.corr, r.corr >= 0.4);
    }

    @Test public void lapelaComecaAntes() { check(737, -2000, 6000); }
    @Test public void lapelaComecaBemAntes() { check(2300, -2000, 6000); }
    @Test public void atrasoQuaseZero() { check(12, -2000, 6000); }
    @Test public void buscaEstreitaPeloRelogio() { check(1480, 1480 - 800, 1480 + 800); }

    @Test
    public void semVozCorrelacaoBaixa() {
        float[] cam = VoiceDspTest.noise(44100 * 15, 0.01, 1);
        float[] ext = VoiceDspTest.noise(48000 * 16, 0.01, 2);
        AudioSync.Result r = AudioSync.findLag(AudioSync.envelope(cam, 44100), AudioSync.envelope(ext, 48000), -2000, 6000);
        System.out.printf("ruído × ruído: correlação %.2f%n", r.corr);
        assertTrue("ruído sem voz não passa do limite (0,3): " + r.corr, r.corr < 0.3);
    }
}
