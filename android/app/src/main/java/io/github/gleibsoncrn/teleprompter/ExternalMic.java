package io.github.gleibsoncrn.teleprompter;

import android.annotation.SuppressLint;
import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTimestamp;
import android.media.MediaRecorder;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/**
 * Grava o microfone EXTERNO (receptor USB‑C da lapela, fone com fio) direto, em PCM 16 bits mono.
 *
 * Por quê: a câmera (CameraX) pede o áudio como "filmadora" (CAMCORDER) e o Android manda esse
 * pedido para o microfone do CELULAR mesmo com um microfone USB ligado. Aqui o pedido é de
 * microfone comum, com o dispositivo externo como preferido.
 */
final class ExternalMic {

    static final int RATE = 48000;

    private AudioRecord rec;
    private Thread thread;
    private volatile boolean running;
    private File file;
    private volatile long startBootNs = -1; // instante (elapsedRealtimeNanos) da amostra 0
    private volatile long frames = 0;
    private volatile float peak = 0;
    private AudioDeviceInfo device;
    private AudioDeviceInfo routed;
    private IOException ioError;

    /** Melhor entrada externa conectada (USB > fone com fio), ou null. */
    static AudioDeviceInfo find(Context ctx) {
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        AudioDeviceInfo best = null;
        int bestRank = 0;
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
            int t = d.getType();
            int rank = t == AudioDeviceInfo.TYPE_USB_DEVICE || t == AudioDeviceInfo.TYPE_USB_HEADSET
                || t == AudioDeviceInfo.TYPE_USB_ACCESSORY ? 2 : t == AudioDeviceInfo.TYPE_WIRED_HEADSET ? 1 : 0;
            if (rank > bestRank) { bestRank = rank; best = d; }
        }
        return best;
    }

    /** Começa a gravar em out. false = o aparelho recusou (segue só com o áudio da câmera). */
    @SuppressLint("MissingPermission") // RECORD_AUDIO verificada por quem chama
    boolean start(AudioDeviceInfo dev, File out) {
        try {
            int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (min <= 0) return false;
            rec = new AudioRecord(MediaRecorder.AudioSource.MIC, RATE, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, Math.max(min * 4, RATE / 5 * 2));
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) { release(); return false; }
            device = dev;
            rec.setPreferredDevice(dev);
            file = out;
            final OutputStream os = new BufferedOutputStream(new FileOutputStream(out), 1 << 16);
            rec.startRecording();
            if (rec.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                os.close();
                release();
                return false;
            }
            running = true;
            thread = new Thread(() -> loop(os), "external-mic");
            thread.setPriority(Thread.MAX_PRIORITY);
            thread.start();
            return true;
        } catch (Exception e) {
            release();
            return false;
        }
    }

    private void loop(OutputStream os) {
        short[] buf = new short[RATE / 50]; // 20 ms
        byte[] bytes = new byte[buf.length * 2];
        AudioTimestamp ts = new AudioTimestamp();
        try {
            while (running) {
                int n = rec.read(buf, 0, buf.length);
                if (n <= 0) continue;
                float p = peak;
                for (int i = 0; i < n; i++) {
                    short v = buf[i];
                    bytes[2 * i] = (byte) v;
                    bytes[2 * i + 1] = (byte) (v >> 8);
                    float a = Math.abs(v / 32768f);
                    if (a > p) p = a;
                }
                peak = p;
                os.write(bytes, 0, n * 2);
                frames += n;
                if (routed == null) routed = rec.getRoutedDevice();
                // Relógio da amostra 0 (fallback da sincronia se a correlação não achar a voz).
                if (startBootNs < 0 && frames > RATE / 2
                    && rec.getTimestamp(ts, AudioTimestamp.TIMEBASE_BOOTTIME) == AudioRecord.SUCCESS) {
                    startBootNs = ts.nanoTime - ts.framePosition * 1_000_000_000L / RATE;
                }
            }
        } catch (IOException e) {
            ioError = e;
        } finally {
            try { os.close(); } catch (IOException ignored) { }
        }
    }

    /** Para e fecha o arquivo. Pode ser chamado mais de uma vez. */
    void stop() {
        running = false;
        if (thread != null) {
            try { thread.join(2000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            thread = null;
        }
        release();
    }

    private void release() {
        if (rec != null) {
            try { rec.stop(); } catch (Exception ignored) { }
            rec.release();
            rec = null;
        }
    }

    File file() { return file; }
    long startBootNs() { return startBootNs; }
    long frames() { return frames; }
    float peak() { return peak; }
    boolean failed() { return ioError != null; }
    AudioDeviceInfo device() { return device; }

    /** Dispositivo que o Android usou de fato (pode ignorar a preferência). */
    AudioDeviceInfo routed() { return routed; }
}
