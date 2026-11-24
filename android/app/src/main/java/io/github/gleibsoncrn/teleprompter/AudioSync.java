package io.github.gleibsoncrn.teleprompter;

/**
 * Sincronia do áudio do microfone externo com o vídeo (Java puro, testável no JUnit).
 *
 * A câmera grava o próprio áudio (microfone do celular) junto com o vídeo; o app grava o
 * receptor USB à parte. Os dois ouvem a MESMA voz, então o deslocamento entre eles é o pico da
 * correlação dos envelopes de volume (resolução de {@link #STEP_MS} ms) — bem mais preciso que
 * comparar relógios.
 */
final class AudioSync {

    static final int STEP_MS = 2;

    private AudioSync() { }

    static final class Result {
        final int lagMs;      // amostra do externo para o instante t da câmera = t + lagMs
        final double corr;    // correlação de Pearson no pico (0..1)
        Result(int lagMs, double corr) { this.lagMs = lagMs; this.corr = corr; }
    }

    /** Envelope: média do |x| em blocos de STEP_MS, em escala log (voz baixa e alta pesam parecido). */
    static float[] envelope(float[] x, int rate) {
        int blk = Math.max(1, rate * STEP_MS / 1000);
        int n = x.length / blk;
        float[] e = new float[n];
        for (int i = 0; i < n; i++) {
            double s = 0;
            for (int j = 0; j < blk; j++) s += Math.abs(x[i * blk + j]);
            e[i] = (float) Math.log(1e-4 + s / blk);
        }
        return e;
    }

    /**
     * Procura o deslocamento (em ms) entre minLagMs e maxLagMs que melhor alinha ext com cam:
     * ext[t + lag] ≈ cam[t]. Exige pelo menos 3 s de sobreposição.
     */
    static Result findLag(float[] camEnv, float[] extEnv, int minLagMs, int maxLagMs) {
        int minLag = Math.floorDiv(minLagMs, STEP_MS);
        int maxLag = Math.floorDiv(maxLagMs, STEP_MS);
        int minOverlap = 3000 / STEP_MS;
        double best = -2;
        int bestLag = 0;
        for (int lag = minLag; lag <= maxLag; lag++) {
            int from = Math.max(0, -lag);
            int to = Math.min(camEnv.length, extEnv.length - lag);
            int n = to - from;
            if (n < minOverlap) continue;
            double sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
            for (int i = from; i < to; i++) {
                double a = camEnv[i];
                double b = extEnv[i + lag];
                sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
            }
            double cov = sab - sa * sb / n;
            double va = saa - sa * sa / n;
            double vb = sbb - sb * sb / n;
            if (va <= 0 || vb <= 0) continue;
            double r = cov / Math.sqrt(va * vb);
            if (r > best) { best = r; bestLag = lag; }
        }
        return new Result(bestLag * STEP_MS, Math.max(0, best));
    }
}
