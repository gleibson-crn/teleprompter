package io.github.gleibsoncrn.teleprompter;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.audio.BaseAudioProcessor;
import androidx.media3.common.util.UnstableApi;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Adaptador do {@link VoiceDsp} para o Media3 (Transformer). Aceita PCM 16 bits ou float, qualquer
 * taxa (44,1/48 kHz do microfone USB, 16 kHz…) e qualquer número de canais; o formato de saída é
 * igual ao de entrada. Formato não suportado → fica inativo (o áudio passa intacto).
 */
@OptIn(markerClass = UnstableApi.class)
final class VoiceAudioProcessor extends BaseAudioProcessor {

    private final int level;
    private VoiceDsp dsp;
    private AudioFormat dspFormat;

    VoiceAudioProcessor(int level) { this.level = level; }

    @Override
    protected AudioFormat onConfigure(AudioFormat in) {
        boolean ok = level != VoiceDsp.OFF
            && (in.encoding == C.ENCODING_PCM_16BIT || in.encoding == C.ENCODING_PCM_FLOAT)
            && in.channelCount >= 1 && in.sampleRate >= 8000;
        return ok ? in : AudioFormat.NOT_SET;
    }

    @Override
    public void queueInput(ByteBuffer input) {
        int bytes = input.remaining();
        if (bytes == 0) return;
        AudioFormat f = inputAudioFormat;
        if (dsp == null || !f.equals(dspFormat)) {
            dsp = new VoiceDsp(f.sampleRate, f.channelCount, level);
            dspFormat = f;
        }
        boolean flt = f.encoding == C.ENCODING_PCM_FLOAT;
        int bps = flt ? 4 : 2;
        int frames = bytes / (bps * f.channelCount);
        int count = frames * f.channelCount;
        float[] in = new float[count];
        ByteBuffer src = input.order(ByteOrder.nativeOrder());
        for (int i = 0; i < count; i++) in[i] = flt ? src.getFloat() : src.getShort() / 32768f;
        input.position(input.limit()); // resto (fração de quadro) não existe em PCM bem formado
        write(dsp.process(in, frames), flt);
    }

    @Override
    protected void onQueueEndOfStream() {
        if (dsp != null) write(dsp.flush(), dspFormat.encoding == C.ENCODING_PCM_FLOAT);
    }

    @Override
    protected void onReset() {
        dsp = null;
        dspFormat = null;
    }

    private void write(float[] out, boolean flt) {
        if (out.length == 0) return;
        ByteBuffer b = replaceOutputBuffer(out.length * (flt ? 4 : 2));
        for (float v : out) {
            if (flt) b.putFloat(v);
            else b.putShort((short) Math.max(-32768, Math.min(32767, Math.round(v * 32767f))));
        }
        b.flip();
    }
}
