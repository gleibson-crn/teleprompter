package io.github.gleibsoncrn.teleprompter;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMetadataRetriever;
import android.media.MediaMuxer;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;

/**
 * Troca o áudio da gravação (microfone do celular, gravado pela câmera) pelo do microfone
 * EXTERNO (PCM gravado pelo ExternalMic), sincronizado pela voz (AudioSync).
 * O vídeo é copiado amostra a amostra (sem recodificar); só o áudio vira AAC.
 */
final class AudioReplacer {

    private static final long TIMEOUT_US = 10_000;
    private static final long HEAD_US = 40_000_000;  // trecho usado para achar a sincronia
    private static final double MIN_CORR = 0.3;

    private AudioReplacer() { }

    static final class Outcome {
        boolean replaced;
        String method = "";   // "voz" (correlação) | "relógio"
        int offsetMs;         // amostra do externo para o instante τ do vídeo = τ + offsetMs
        double corr;
        String reason = "";
    }

    /**
     * @param extStartBootNs relógio da amostra 0 do externo (-1 = desconhecido)
     * @param videoStartBootNs relógio estimado do 1º quadro do vídeo (-1 = desconhecido)
     */
    static Outcome run(File video, File pcm, long extStartBootNs, long videoStartBootNs, File tmp) throws IOException {
        Outcome o = new Outcome();
        final int rate = ExternalMic.RATE;
        long extFrames = pcm.length() / 2;

        MediaExtractor ex = new MediaExtractor();
        try {
            ex.setDataSource(video.getAbsolutePath());
            int vT = -1, aT = -1;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                String m = ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME);
                if (m == null) continue;
                if (vT < 0 && m.startsWith("video/")) vT = i;
                if (aT < 0 && m.startsWith("audio/")) aT = i;
            }
            if (vT < 0) { o.reason = "sem vídeo"; return o; }
            MediaFormat vf = ex.getTrackFormat(vT);
            long v0 = firstSampleUs(ex, vT);
            long durUs = vf.containsKey(MediaFormat.KEY_DURATION) ? vf.getLong(MediaFormat.KEY_DURATION) : metaDurationUs(video);
            if (durUs <= 0) { o.reason = "duração desconhecida"; return o; }

            // ---- sincronia
            double tsOff = Double.NaN;
            if (extStartBootNs > 0 && videoStartBootNs > 0) tsOff = (videoStartBootNs - extStartBootNs) / 1e6;
            boolean found = false;
            if (aT >= 0) {
                long[] a0 = { -1 };
                int[] camRate = { 0 };
                float[] cam = decodeHead(ex, aT, HEAD_US, a0, camRate);
                if (cam.length > camRate[0] * 4L && a0[0] >= 0) {
                    float[] ext = readPcmHead(pcm, (int) Math.min(extFrames, (HEAD_US / 1_000_000 + 8) * rate));
                    // ext em ms = (τ do vídeo) + off; cam em ms = τ + (v0 − a0)/1000 → lag = off − (v0 − a0)/1000
                    double camShift = (v0 - a0[0]) / 1000.0;
                    int lo, hi;
                    if (!Double.isNaN(tsOff)) { lo = (int) (tsOff - camShift - 800); hi = (int) (tsOff - camShift + 800); }
                    else { lo = -2000; hi = 6000; }
                    AudioSync.Result r = AudioSync.findLag(AudioSync.envelope(cam, camRate[0]), AudioSync.envelope(ext, rate), lo, hi);
                    o.corr = r.corr;
                    if (r.corr >= MIN_CORR) {
                        o.offsetMs = (int) Math.round(r.lagMs + camShift);
                        o.method = "voz";
                        found = true;
                    }
                }
            }
            if (!found && !Double.isNaN(tsOff)) {
                o.offsetMs = (int) Math.round(tsOff);
                o.method = "relógio";
                found = true;
            }
            if (!found) { o.reason = "não deu para sincronizar"; return o; }

            // ---- AAC do externo, alinhado ao vídeo
            List<byte[]> data = new ArrayList<>();
            List<Long> pts = new ArrayList<>();
            MediaFormat af = encode(pcm, extFrames, (long) o.offsetMs * rate / 1000, durUs, v0, data, pts);
            if (af == null) { o.reason = "codificador de áudio falhou"; return o; }

            // ---- MP4 novo: vídeo copiado + áudio novo, intercalados por tempo
            MediaMuxer mux = new MediaMuxer(tmp.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            try {
                mux.setOrientationHint(metaRotation(video));
                int mv = mux.addTrack(vf);
                int ma = mux.addTrack(af);
                mux.start();
                ex.selectTrack(vT);
                ex.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC);
                int cap = vf.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE) ? vf.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) : 0;
                ByteBuffer vb = ByteBuffer.allocateDirect(Math.max(cap, 8 << 20));
                MediaCodec.BufferInfo bi = new MediaCodec.BufferInfo();
                int ai = 0;
                while (true) {
                    long vt = ex.getSampleTime();
                    if (ai < data.size() && (vt < 0 || pts.get(ai) <= vt)) {
                        byte[] d = data.get(ai);
                        bi.set(0, d.length, pts.get(ai), 0);
                        mux.writeSampleData(ma, ByteBuffer.wrap(d), bi);
                        ai++;
                        continue;
                    }
                    if (vt < 0) break;
                    vb.clear();
                    int sz = ex.readSampleData(vb, 0);
                    if (sz < 0) break;
                    int flags = (ex.getSampleFlags() & MediaExtractor.SAMPLE_FLAG_SYNC) != 0 ? MediaCodec.BUFFER_FLAG_KEY_FRAME : 0;
                    bi.set(0, sz, vt, flags);
                    mux.writeSampleData(mv, vb, bi);
                    ex.advance();
                }
                mux.stop();
            } finally {
                mux.release();
            }
            o.replaced = true;
            return o;
        } finally {
            ex.release();
        }
    }

    private static long firstSampleUs(MediaExtractor ex, int track) {
        ex.selectTrack(track);
        ex.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC);
        long t = Math.max(0, ex.getSampleTime());
        ex.unselectTrack(track);
        return t;
    }

    /** Decodifica o começo de uma faixa de áudio para mono float. a0[0] = tempo da 1ª amostra (µs). */
    private static float[] decodeHead(MediaExtractor ex, int track, long maxUs, long[] a0, int[] rateOut) throws IOException {
        MediaFormat f = ex.getTrackFormat(track);
        int ch = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
        rateOut[0] = f.getInteger(MediaFormat.KEY_SAMPLE_RATE);
        boolean flt = false;
        MediaCodec dec = MediaCodec.createDecoderByType(f.getString(MediaFormat.KEY_MIME));
        VoiceDsp.FloatBuf out = new VoiceDsp.FloatBuf(1 << 20);
        try {
            dec.configure(f, null, null, 0);
            dec.start();
            ex.selectTrack(track);
            ex.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC);
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inEos = false;
            long firstIn = -1;
            for (int guard = 0; guard < 200_000; guard++) {
                if (!inEos) {
                    int i = dec.dequeueInputBuffer(TIMEOUT_US);
                    if (i >= 0) {
                        ByteBuffer b = dec.getInputBuffer(i);
                        int sz = b != null ? ex.readSampleData(b, 0) : -1;
                        long t = ex.getSampleTime();
                        if (firstIn < 0 && t >= 0) firstIn = t;
                        if (sz < 0 || t - firstIn > maxUs) {
                            dec.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inEos = true;
                        } else {
                            dec.queueInputBuffer(i, 0, sz, t, 0);
                            ex.advance();
                        }
                    }
                }
                int o = dec.dequeueOutputBuffer(info, TIMEOUT_US);
                if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat of = dec.getOutputFormat();
                    ch = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    rateOut[0] = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    flt = of.containsKey(MediaFormat.KEY_PCM_ENCODING)
                        && of.getInteger(MediaFormat.KEY_PCM_ENCODING) == android.media.AudioFormat.ENCODING_PCM_FLOAT;
                } else if (o >= 0) {
                    ByteBuffer b = dec.getOutputBuffer(o);
                    if (b != null && info.size > 0) {
                        if (a0[0] < 0) a0[0] = info.presentationTimeUs;
                        b.position(info.offset);
                        b.limit(info.offset + info.size);
                        b.order(ByteOrder.nativeOrder());
                        int frames = info.size / ((flt ? 4 : 2) * ch);
                        for (int k = 0; k < frames; k++) {
                            float s = 0;
                            for (int c = 0; c < ch; c++) s += flt ? b.getFloat() : b.getShort() / 32768f;
                            out.add(s / ch);
                        }
                    }
                    dec.releaseOutputBuffer(o, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
                }
            }
        } finally {
            try { dec.stop(); } catch (Exception ignored) { }
            dec.release();
            ex.unselectTrack(track);
        }
        return out.toArray();
    }

    private static float[] readPcmHead(File pcm, int frames) throws IOException {
        float[] x = new float[Math.max(0, frames)];
        try (RandomAccessFile raf = new RandomAccessFile(pcm, "r")) {
            byte[] b = new byte[x.length * 2];
            raf.readFully(b, 0, Math.min(b.length, (int) raf.length()));
            for (int i = 0; i < x.length; i++) x[i] = (short) ((b[2 * i] & 0xff) | (b[2 * i + 1] << 8)) / 32768f;
        }
        return x;
    }

    /**
     * Codifica em AAC o PCM externo a partir da amostra src0 (negativa = silêncio antes), com a
     * duração do vídeo; carimba os tempos a partir de v0. Devolve o formato de saída (para o muxer).
     */
    private static MediaFormat encode(File pcm, long extFrames, long src0, long durUs, long v0,
                                      List<byte[]> data, List<Long> pts) throws IOException {
        final int rate = ExternalMic.RATE;
        MediaFormat f = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, rate, 1);
        f.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        f.setInteger(MediaFormat.KEY_BIT_RATE, 160_000);
        f.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);
        MediaCodec enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        MediaFormat outFmt = null;
        long total = durUs * rate / 1_000_000;
        long pos = 0;
        boolean inEos = false;
        byte[] chunk = new byte[4096];
        try (RandomAccessFile raf = new RandomAccessFile(pcm, "r")) {
            enc.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            enc.start();
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            while (true) {
                if (!inEos) {
                    int i = enc.dequeueInputBuffer(TIMEOUT_US);
                    if (i >= 0) {
                        ByteBuffer b = enc.getInputBuffer(i);
                        long t = v0 + pos * 1_000_000 / rate;
                        if (b == null || pos >= total) {
                            enc.queueInputBuffer(i, 0, 0, t, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inEos = true;
                        } else {
                            int n = (int) Math.min(Math.min(b.capacity(), chunk.length) / 2, total - pos);
                            fill(raf, extFrames, src0 + pos, n, chunk);
                            b.clear();
                            b.put(chunk, 0, n * 2);
                            enc.queueInputBuffer(i, 0, n * 2, t, 0);
                            pos += n;
                        }
                    }
                }
                int o = enc.dequeueOutputBuffer(info, TIMEOUT_US);
                if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    outFmt = enc.getOutputFormat();
                } else if (o >= 0) {
                    ByteBuffer b = enc.getOutputBuffer(o);
                    if (b != null && info.size > 0 && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                        byte[] d = new byte[info.size];
                        b.position(info.offset);
                        b.get(d, 0, info.size);
                        data.add(d);
                        pts.add(info.presentationTimeUs);
                    }
                    enc.releaseOutputBuffer(o, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
                }
            }
        } catch (IllegalStateException e) {
            return null;
        } finally {
            try { enc.stop(); } catch (Exception ignored) { }
            enc.release();
        }
        return outFmt;
    }

    /** n amostras (16 bits LE) a partir de src; fora do arquivo = silêncio. */
    private static void fill(RandomAccessFile raf, long extFrames, long src, int n, byte[] dst) throws IOException {
        java.util.Arrays.fill(dst, 0, n * 2, (byte) 0);
        long from = Math.max(src, 0);
        long to = Math.min(src + n, extFrames);
        if (to <= from) return;
        raf.seek(from * 2);
        raf.readFully(dst, (int) (from - src) * 2, (int) (to - from) * 2);
    }

    private static long metaDurationUs(File f) {
        MediaMetadataRetriever m = new MediaMetadataRetriever();
        try {
            m.setDataSource(f.getAbsolutePath());
            String d = m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            return d != null ? Long.parseLong(d) * 1000 : 0;
        } catch (Exception e) {
            return 0;
        } finally {
            try { m.release(); } catch (Exception ignored) { }
        }
    }

    private static int metaRotation(File f) {
        MediaMetadataRetriever m = new MediaMetadataRetriever();
        try {
            m.setDataSource(f.getAbsolutePath());
            String r = m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
            return r != null ? Integer.parseInt(r) : 0;
        } catch (Exception e) {
            return 0;
        } finally {
            try { m.release(); } catch (Exception ignored) { }
        }
    }
}
