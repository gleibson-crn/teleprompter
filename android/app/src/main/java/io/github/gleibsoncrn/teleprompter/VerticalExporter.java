package io.github.gleibsoncrn.teleprompter;

import android.content.Context;
import android.graphics.Matrix;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.OptIn;
import androidx.media3.common.Effect;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.MatrixTransformation;
import androidx.media3.effect.Presentation;
import androidx.media3.transformer.Composition;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.Effects;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.ProgressHolder;
import androidx.media3.transformer.Transformer;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * Pós-gravação com o Media3 Transformer:
 *  - VERTICAL (9:16): a partir do horizontal gravado + caminho do recorte (Reframer), move o quadro
 *    para o centro do recorte, corta 9:16 e recodifica no codificador de HARDWARE;
 *  - VOZ: aplica o tratamento de voz (VoiceAudioProcessor). Sem caminho do recorte, só o áudio é
 *    recodificado e o vídeo é copiado como está.
 * Tudo na thread principal (exigência do Transformer); o trabalho pesado roda no codec/GPU.
 */
@OptIn(markerClass = UnstableApi.class)
final class VerticalExporter {

    /** Igual ao LOOKAHEAD_MS do js/reframe.js: o recorte antecipa o movimento. */
    private static final double LOOKAHEAD_MS = 200;

    interface Callback {
        void onProgress(int percent);
        void onDone(File out);
        void onError(String message);
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private Transformer transformer;
    private Runnable poll;

    /**
     * @param path caminho do recorte; null = não mexe no vídeo (só trata o áudio)
     * @param srcW largura do horizontal como ele aparece (já girado)
     * @param srcH altura idem
     * @param voiceLevel VoiceDsp.OFF / LEVE / FORTE
     */
    void start(Context ctx, File src, File out, List<Reframer.Point> path, int srcW, int srcH, int voiceLevel, Callback cb) {
        cancel();
        List<AudioProcessor> audio = new ArrayList<>();
        if (voiceLevel != VoiceDsp.OFF) audio.add(new VoiceAudioProcessor(voiceLevel));
        List<Effect> video = path != null ? cropEffects(path, srcW, srcH) : new ArrayList<>();

        EditedMediaItem item = new EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(src)))
            .setEffects(new Effects(audio, video))
            .build();

        Transformer.Builder tb = new Transformer.Builder(ctx);
        if (path != null) tb.setVideoMimeType(MimeTypes.VIDEO_H264);
        transformer = tb
            .addListener(new Transformer.Listener() {
                @Override
                public void onCompleted(Composition composition, ExportResult result) {
                    finish();
                    cb.onDone(out);
                }

                @Override
                public void onError(Composition composition, ExportResult result, ExportException e) {
                    finish();
                    //noinspection ResultOfMethodCallIgnored
                    out.delete();
                    cb.onError(e.getMessage() != null ? e.getMessage() : "falha no codificador");
                }
            })
            .build();
        transformer.start(item, out.getAbsolutePath());

        final ProgressHolder ph = new ProgressHolder();
        poll = new Runnable() {
            @Override
            public void run() {
                if (transformer == null) return;
                if (transformer.getProgress(ph) == Transformer.PROGRESS_STATE_AVAILABLE) cb.onProgress(ph.progress);
                main.postDelayed(this, 300);
            }
        };
        main.postDelayed(poll, 300);
    }

    private static List<Effect> cropEffects(List<Reframer.Point> path, int srcW, int srcH) {
        // Recorte: altura inteira; largura 9:16 arredondada para múltiplo de 16 (alguns
        // codificadores MediaTek recusam outras larguras). 1080p → 608×1080; 720p → 400×720.
        final int outH = srcH & ~1;
        final int outW = Math.max(16, Math.round(outH * 9f / 16f / 16f) * 16);
        final double half = (outH * 9.0 / 16.0) / srcW / 2.0;
        final List<Reframer.Point> p = new ArrayList<>(path);

        MatrixTransformation move = (long presentationTimeUs) -> {
            double c = Reframer.centerAt(p, presentationTimeUs / 1000.0 + LOOKAHEAD_MS);
            c = Math.max(half, Math.min(1 - half, c));
            Matrix m = new Matrix();
            // Coordenadas normalizadas (-1..1): leva o centro do recorte para o meio do quadro.
            m.postTranslate((float) ((0.5 - c) * 2.0), 0f);
            return m;
        };
        List<Effect> video = new ArrayList<>();
        video.add(move);
        video.add(Presentation.createForWidthAndHeight(outW, outH, Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP));
        return video;
    }

    boolean running() { return transformer != null; }

    /** Cancela (fechou o resultado ou o app saiu). Chamar na thread principal. */
    void cancel() {
        if (transformer != null) transformer.cancel();
        finish();
    }

    private void finish() {
        if (poll != null) main.removeCallbacks(poll);
        poll = null;
        transformer = null;
    }
}
