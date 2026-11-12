package io.github.gleibsoncrn.teleprompter;

import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.SystemClock;

import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;

import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.face.Face;
import com.google.mlkit.vision.face.FaceDetection;
import com.google.mlkit.vision.face.FaceDetector;
import com.google.mlkit.vision.face.FaceDetectorOptions;

import java.util.ArrayList;
import java.util.List;

/**
 * Vertical inteligente no APK: acha o rosto (ML Kit, no aparelho) em quadros pequenos da
 * câmera e calcula o centro do recorte 9:16 com a MESMA suavização do PWA (js/reframe.js).
 *
 * Coordenadas: centro normalizado 0..1 na largura do quadro como ele fica no ARQUIVO gravado
 * (já girado e sem espelho). O preview frontal é espelhado; quem desenha a máscara inverte.
 * Durante a gravação guarda o caminho (t em ms desde o início, centro) para gerar o vertical.
 */
final class Reframer implements ImageAnalysis.Analyzer {

    // Iguais ao js/reframe.js (em fração da largura do quadro).
    private static final long DETECT_EVERY_MS = 66;
    private static final double DEAD_ZONE = 0.035;
    private static final double SETTLE = 0.01;
    private static final double SMOOTH_TAU = 0.16;
    private static final double MAX_SPEED = 1.6;
    private static final long LOST_AFTER_MS = 1500;

    interface Listener { void onCenter(double center, int faces); }

    static final class Point {
        final double t;
        final double c;
        Point(double t, double c) { this.t = t; this.c = c; }
    }

    private final FaceDetector detector = FaceDetection.getClient(new FaceDetectorOptions.Builder()
        .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
        .setMinFaceSize(0.1f)
        .build());
    private final Listener listener;

    private volatile boolean enabled = true; // false com o celular em pé (nada a seguir)
    private long lastDetect = 0;
    private long lastStep = 0;
    private long lastFaceAt = 0;
    private double center = 0.5;
    private double target = 0.5;
    private boolean moving = false;
    private double half = 0.5 * 9 / 16 * 9 / 16; // meia largura do recorte (fração); ajustada pelo quadro

    private final Object lock = new Object();
    private List<Point> path = null;
    private long pathT0 = 0;

    Reframer(Listener listener) { this.listener = listener; }

    void setEnabled(boolean on) { enabled = on; }

    /** Seguir o rosto desligado: o recorte fica no centro (sem detecção). */
    void setFollow(boolean on) { follow = on; }
    private volatile boolean follow = true;

    /** Começa a guardar o caminho (t = 0 agora, quando a gravação começou de fato). */
    void beginPath() {
        synchronized (lock) {
            path = new ArrayList<>();
            pathT0 = SystemClock.elapsedRealtime();
            path.add(new Point(0, center));
        }
    }

    /** Para de guardar e devolve o caminho (null se não estava guardando ou celular em pé). */
    List<Point> endPath() {
        synchronized (lock) {
            List<Point> p = path;
            path = null;
            return enabled ? p : null;
        }
    }

    void close() { detector.close(); }

    @Override
    public void analyze(ImageProxy image) {
        try {
            long now = SystemClock.elapsedRealtime();
            if (!enabled || now - lastDetect < DETECT_EVERY_MS) return;
            lastDetect = now;
            int rot = image.getImageInfo().getRotationDegrees();
            Bitmap bmp = image.toBitmap();
            boolean swap = rot == 90 || rot == 270;
            int w = swap ? bmp.getHeight() : bmp.getWidth();
            int h = swap ? bmp.getWidth() : bmp.getHeight();
            if (h >= w) { setCenterNoFace(now); return; } // quadro em pé: o vertical é ele inteiro
            half = (h * 9.0 / 16.0) / w / 2.0;
            if (!follow) { setCenterNoFace(now); listener.onCenter(center, 0); return; }
            List<Face> faces = Tasks.await(detector.process(InputImage.fromBitmap(bmp, rot)));
            if (!faces.isEmpty()) {
                // Maior rosto = quem está lendo.
                Rect best = faces.get(0).getBoundingBox();
                for (Face f : faces) {
                    Rect b = f.getBoundingBox();
                    if (b.width() * b.height() > best.width() * best.height()) best = b;
                }
                target = best.exactCenterX() / w;
                lastFaceAt = now;
            }
            if (now - lastFaceAt > LOST_AFTER_MS) target = 0.5;
            step(now);
            listener.onCenter(center, faces.size());
        } catch (Exception ignored) {
            // um quadro perdido não importa
        } finally {
            image.close();
        }
    }

    private void setCenterNoFace(long now) {
        target = 0.5;
        step(now);
    }

    /** Mesmo cálculo de stepCenter (js/reframe.js): histerese, suavização e velocidade máxima. */
    private void step(long now) {
        double dt = lastStep == 0 ? 0 : Math.min((now - lastStep) / 1000.0, 0.2);
        lastStep = now;
        double diff = target - center;
        if (!moving && Math.abs(diff) < DEAD_ZONE) {
            moving = false;
        } else if (moving && Math.abs(diff) < SETTLE) {
            moving = false;
        } else {
            double s = diff * (1 - Math.exp(-dt / SMOOTH_TAU));
            double max = MAX_SPEED * dt;
            center += Math.max(-max, Math.min(max, s));
            moving = true;
        }
        center = Math.max(half, Math.min(1 - half, center));
        synchronized (lock) {
            if (path != null) path.add(new Point(now - pathT0, center));
        }
    }

    /** Centro no instante t (ms), interpolado (igual a centerAt do js/reframe.js). */
    static double centerAt(List<Point> path, double t) {
        if (path.isEmpty()) return 0.5;
        if (t <= path.get(0).t) return path.get(0).c;
        Point last = path.get(path.size() - 1);
        if (t >= last.t) return last.c;
        int lo = 0;
        int hi = path.size() - 1;
        while (hi - lo > 1) {
            int mid = (lo + hi) >>> 1;
            if (path.get(mid).t <= t) lo = mid; else hi = mid;
        }
        Point a = path.get(lo);
        Point b = path.get(hi);
        return a.c + (b.c - a.c) * (t - a.t) / Math.max(1e-6, b.t - a.t);
    }
}
