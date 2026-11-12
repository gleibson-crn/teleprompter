package io.github.gleibsoncrn.teleprompter;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.hardware.display.DisplayManager;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Range;
import android.view.Display;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.DynamicRange;
import androidx.camera.core.Preview;
import androidx.camera.core.ZoomState;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.video.FallbackStrategy;
import androidx.camera.video.FileOutputOptions;
import androidx.camera.video.PendingRecording;
import androidx.camera.video.Quality;
import androidx.camera.video.QualitySelector;
import androidx.camera.video.Recorder;
import androidx.camera.video.Recording;
import androidx.camera.video.VideoCapture;
import androidx.camera.video.VideoRecordEvent;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.lifecycle.LifecycleOwner;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.google.common.util.concurrent.ListenableFuture;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Set;

/**
 * Câmera e gravação NATIVAS (CameraX) para o Teleprompter.
 *
 * O preview (PreviewView) fica ATRÁS da WebView, que fica transparente enquanto a câmera
 * está aberta: o texto do teleprompter (web) aparece por cima. A gravação usa o codificador
 * de vídeo por hardware do aparelho (MediaCodec), que o Chrome não libera em vários
 * aparelhos MediaTek — era a causa dos ~4 fps no PWA.
 *
 * O arquivo gravado NÃO é espelhado (padrão do VideoCapture), mesmo com o preview frontal
 * espelhado — decisão do dono.
 */
@CapacitorPlugin(
    name = "TeleprompterCamera",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class TeleprompterCameraPlugin extends Plugin {

    private static final String REC_PREFIX = "teleprompter-";

    private PreviewView previewView;
    private ProcessCameraProvider provider;
    private Camera camera;
    private Preview preview;
    private VideoCapture<Recorder> videoCapture;
    private Recording recording;
    private File recFile;
    private PluginCall stopCall;
    private int activeFps = 30;
    private DisplayManager.DisplayListener displayListener;

    @Override
    public void load() {
        getActivity().runOnUiThread(() -> {
            WebView wv = getBridge().getWebView();
            ViewGroup parent = (ViewGroup) wv.getParent();
            previewView = new PreviewView(getContext());
            previewView.setImplementationMode(PreviewView.ImplementationMode.PERFORMANCE);
            previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
            previewView.setVisibility(View.GONE);
            parent.addView(previewView, 0, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        });
        // Gravações de sessões anteriores que não foram salvas: apaga.
        File dir = recDir();
        File[] old = dir.listFiles((d, name) -> name.startsWith(REC_PREFIX) && name.endsWith(".mp4"));
        if (old != null) for (File f : old) //noinspection ResultOfMethodCallIgnored
            f.delete();
        //noinspection ResultOfMethodCallIgnored
        updateFile().delete(); // APK de uma atualização já instalada (ou abandonada)
    }

    // ---------------------------------------------------------------- preview

    @PluginMethod
    public void startPreview(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("Permissão de câmera negada.", "PERMISSION");
            return;
        }
        final String facing = call.getString("facing", "user");
        final int quality = call.getInt("quality", 1080);
        final int fps = call.getInt("fps", 30);
        final Context ctx = getContext();
        final ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(ctx);
        future.addListener(() -> {
            try {
                provider = future.get();
                bind(facing, quality, fps);
                showPreview(true);
                call.resolve(cameraInfo());
            } catch (Exception e) {
                call.reject("Não foi possível abrir a câmera: " + e.getMessage(), "CAMERA", e);
            }
        }, ContextCompat.getMainExecutor(ctx));
    }

    /** Liga Preview + VideoCapture. 60 fps só se o aparelho suportar; senão cai para 30. */
    private void bind(String facing, int quality, int fps) {
        CameraSelector selector = "environment".equals(facing)
            ? CameraSelector.DEFAULT_BACK_CAMERA
            : CameraSelector.DEFAULT_FRONT_CAMERA;
        int target = fps;
        if (target > 30) {
            bindWith(selector, quality, 30);
            if (!supportsFps(target)) target = 30;
        }
        try {
            bindWith(selector, quality, target);
        } catch (IllegalArgumentException e) {
            if (target == 30) throw e;
            target = 30;
            bindWith(selector, quality, target);
        }
        activeFps = target;
    }

    private void bindWith(CameraSelector selector, int quality, int fps) {
        provider.unbindAll();
        int rotation = displayRotation();
        Range<Integer> range = new Range<>(fps, fps);
        Quality q = quality >= 1080 ? Quality.FHD : Quality.HD;
        Recorder recorder = new Recorder.Builder()
            .setQualitySelector(QualitySelector.from(q, FallbackStrategy.lowerQualityOrHigherThan(Quality.SD)))
            .build();
        videoCapture = new VideoCapture.Builder<>(recorder)
            .setTargetFrameRate(range)
            .setTargetRotation(rotation)
            .build();
        preview = new Preview.Builder()
            .setTargetFrameRate(range)
            .setTargetRotation(rotation)
            .build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());
        camera = provider.bindToLifecycle((LifecycleOwner) getActivity(), selector, preview, videoCapture);
    }

    private boolean supportsFps(int fps) {
        if (camera == null) return false;
        Set<Range<Integer>> ranges = camera.getCameraInfo().getSupportedFrameRateRanges();
        for (Range<Integer> r : ranges) {
            if (r.getLower() <= fps && r.getUpper() >= fps) return true;
        }
        return false;
    }

    private JSObject cameraInfo() {
        JSObject r = new JSObject();
        ZoomState z = camera.getCameraInfo().getZoomState().getValue();
        r.put("zoomMin", z != null ? z.getMinZoomRatio() : 1f);
        r.put("zoomMax", z != null ? z.getMaxZoomRatio() : 1f);
        r.put("zoom", z != null ? z.getZoomRatio() : 1f);
        r.put("fps", activeFps);
        r.put("fps60", supportsFps(60));
        // Maior resolução de GRAVAÇÃO desta câmera (a frontal de muitos aparelhos para em 720p).
        int maxH = 0;
        try {
            for (Quality q : Recorder.getVideoCapabilities(camera.getCameraInfo()).getSupportedQualities(DynamicRange.SDR)) {
                int h = q == Quality.UHD ? 2160 : q == Quality.FHD ? 1080 : q == Quality.HD ? 720 : q == Quality.SD ? 480 : 0;
                if (h > maxH) maxH = h;
            }
        } catch (Exception ignored) { }
        r.put("maxHeight", maxH);
        return r;
    }

    @PluginMethod
    public void stopPreview(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recording != null) recording.stop();
            if (provider != null) provider.unbindAll();
            camera = null;
            preview = null;
            videoCapture = null;
            showPreview(false);
            call.resolve();
        });
    }

    private void showPreview(boolean on) {
        WebView wv = getBridge().getWebView();
        // Transparente só com a câmera aberta (o resto do app tem fundo próprio).
        wv.setBackgroundColor(on ? Color.TRANSPARENT : Color.parseColor("#0b0d12"));
        previewView.setVisibility(on ? View.VISIBLE : View.GONE);
        DisplayManager dm = (DisplayManager) getContext().getSystemService(Context.DISPLAY_SERVICE);
        if (on && displayListener == null) {
            displayListener = new DisplayManager.DisplayListener() {
                @Override public void onDisplayAdded(int id) {}
                @Override public void onDisplayRemoved(int id) {}
                @Override public void onDisplayChanged(int id) {
                    int rot = displayRotation();
                    if (preview != null) preview.setTargetRotation(rot);
                    // Durante a gravação a orientação do arquivo fica a do início.
                    if (videoCapture != null && recording == null) videoCapture.setTargetRotation(rot);
                }
            };
            dm.registerDisplayListener(displayListener, null);
        } else if (!on && displayListener != null) {
            dm.unregisterDisplayListener(displayListener);
            displayListener = null;
        }
    }

    private int displayRotation() {
        DisplayManager dm = (DisplayManager) getContext().getSystemService(Context.DISPLAY_SERVICE);
        Display d = dm.getDisplay(Display.DEFAULT_DISPLAY);
        return d != null ? d.getRotation() : 0;
    }

    @PluginMethod
    public void setZoom(PluginCall call) {
        final float ratio = call.getFloat("ratio", 1f);
        getActivity().runOnUiThread(() -> {
            if (camera == null) { call.reject("Câmera fechada."); return; }
            camera.getCameraControl().setZoomRatio(ratio);
            call.resolve();
        });
    }

    // ---------------------------------------------------------------- gravação

    @SuppressLint("MissingPermission") // RECORD_AUDIO verificada logo abaixo
    @PluginMethod
    public void startRecording(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (videoCapture == null) { call.reject("Câmera fechada."); return; }
            if (recording != null) { call.reject("Já está gravando."); return; }
            recFile = new File(recDir(), REC_PREFIX + System.currentTimeMillis() + ".mp4");
            videoCapture.setTargetRotation(displayRotation());
            PendingRecording pending = videoCapture.getOutput()
                .prepareRecording(getContext(), new FileOutputOptions.Builder(recFile).build());
            boolean audio = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
            if (audio) pending = pending.withAudioEnabled();
            recording = pending.start(ContextCompat.getMainExecutor(getContext()), event -> {
                if (event instanceof VideoRecordEvent.Finalize) onFinalize((VideoRecordEvent.Finalize) event);
            });
            JSObject r = new JSObject();
            r.put("audio", audio);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void stopRecording(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recording == null) { call.reject("Não está gravando."); return; }
            stopCall = call;
            recording.stop();
        });
    }

    /** Arquivo pronto: lê os metadados em segundo plano e entrega para a web. */
    private void onFinalize(VideoRecordEvent.Finalize ev) {
        recording = null;
        final File f = recFile;
        final long durNs = ev.getRecordingStats().getRecordedDurationNanos();
        final int error = ev.getError();
        new Thread(() -> {
            JSObject r = new JSObject();
            r.put("path", f.getAbsolutePath());
            r.put("durationMs", durNs / 1_000_000L);
            if (error != VideoRecordEvent.Finalize.ERROR_NONE) r.put("error", error);
            boolean ok = f.exists() && f.length() > 0;
            r.put("ok", ok);
            if (ok) {
                r.put("bytes", f.length());
                readMetadata(f, r);
            }
            getActivity().runOnUiThread(() -> {
                if (stopCall != null) {
                    stopCall.resolve(r);
                    stopCall = null;
                } else {
                    // Parou sem a web pedir (app foi para segundo plano): avisa por evento.
                    notifyListeners("recordingFinished", r, true);
                }
            });
        }).start();
    }

    private void readMetadata(File f, JSObject r) {
        MediaMetadataRetriever mmr = new MediaMetadataRetriever();
        try {
            mmr.setDataSource(f.getAbsolutePath());
            int w = parseInt(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
            int h = parseInt(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
            int rot = parseInt(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION));
            long dur = parseInt(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
            int frames = parseInt(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT));
            boolean swap = rot == 90 || rot == 270;
            r.put("width", swap ? h : w);
            r.put("height", swap ? w : h);
            r.put("frames", frames);
            if (dur > 0) r.put("fpsReal", Math.round(frames * 10000.0 / dur) / 10.0);
        } catch (Exception ignored) {
            // metadados são só informativos
        } finally {
            try { mmr.release(); } catch (Exception ignored) { }
        }
        // Codificador provável: o padrão do sistema para o tipo de vídeo do arquivo.
        MediaExtractor ex = new MediaExtractor();
        try {
            ex.setDataSource(f.getAbsolutePath());
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat fmt = ex.getTrackFormat(i);
                String mime = fmt.getString(MediaFormat.KEY_MIME);
                if (mime == null || !mime.startsWith("video/")) continue;
                r.put("codec", mime);
                MediaFormat probe = MediaFormat.createVideoFormat(mime,
                    fmt.getInteger(MediaFormat.KEY_WIDTH), fmt.getInteger(MediaFormat.KEY_HEIGHT));
                MediaCodecList list = new MediaCodecList(MediaCodecList.REGULAR_CODECS);
                String name = list.findEncoderForFormat(probe);
                if (name != null) {
                    r.put("encoder", name);
                    for (MediaCodecInfo info : list.getCodecInfos()) {
                        if (info.getName().equals(name)) r.put("encoderHardware", info.isHardwareAccelerated());
                    }
                }
                break;
            }
        } catch (Exception ignored) {
            // idem
        } finally {
            ex.release();
        }
    }

    private static int parseInt(String s) {
        try { return s == null ? 0 : Integer.parseInt(s); } catch (NumberFormatException e) { return 0; }
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        // Foi para segundo plano gravando: fecha o arquivo direito (o resultado chega por evento).
        if (recording != null) recording.stop();
    }

    @Override
    protected void handleOnDestroy() {
        if (provider != null) provider.unbindAll();
        super.handleOnDestroy();
    }

    // ---------------------------------------------------------------- arquivos

    private File recDir() {
        File d = getContext().getExternalFilesDir(Environment.DIRECTORY_MOVIES);
        if (d == null) d = new File(getContext().getFilesDir(), "movies");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    /** Só aceita arquivos de gravação do próprio app (nunca um caminho arbitrário vindo da web). */
    private File ownFile(PluginCall call) {
        String path = call.getString("path");
        if (path == null) return null;
        try {
            File f = new File(path).getCanonicalFile();
            File dir = recDir().getCanonicalFile();
            if (f.getParentFile() == null || !f.getParentFile().equals(dir)) return null;
            if (!f.getName().startsWith(REC_PREFIX) || !f.exists()) return null;
            return f;
        } catch (IOException e) {
            return null;
        }
    }

    @PluginMethod
    public void saveToGallery(PluginCall call) {
        File f = ownFile(call);
        if (f == null) { call.reject("Arquivo não encontrado."); return; }
        String name = call.getString("name", f.getName());
        ContentResolver cr = getContext().getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.Video.Media.DISPLAY_NAME, name);
        v.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
        v.put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/Teleprompter");
        v.put(MediaStore.Video.Media.IS_PENDING, 1);
        Uri uri = cr.insert(MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
        if (uri == null) { call.reject("Não foi possível salvar na galeria."); return; }
        try (InputStream in = new FileInputStream(f); OutputStream out = cr.openOutputStream(uri)) {
            if (out == null) throw new IOException("sem saída");
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } catch (IOException e) {
            cr.delete(uri, null, null);
            call.reject("Não foi possível salvar na galeria: " + e.getMessage());
            return;
        }
        v.clear();
        v.put(MediaStore.Video.Media.IS_PENDING, 0);
        cr.update(uri, v, null, null);
        JSObject r = new JSObject();
        r.put("folder", "Movies/Teleprompter");
        call.resolve(r);
    }

    @PluginMethod
    public void shareFile(PluginCall call) {
        File f = ownFile(call);
        if (f == null) { call.reject("Arquivo não encontrado."); return; }
        Context ctx = getContext();
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("video/mp4");
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getActivity().startActivity(Intent.createChooser(send, "Compartilhar vídeo"));
        call.resolve();
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        File f = ownFile(call);
        JSObject r = new JSObject();
        r.put("deleted", f != null && f.delete());
        call.resolve(r);
    }

    /** Exportar roteiros: grava em Downloads (a WebView não faz download por <a download>). */
    @PluginMethod
    public void saveText(PluginCall call) {
        String name = call.getString("name", "teleprompter.txt");
        String text = call.getString("text", "");
        String mime = call.getString("mime", "text/plain");
        ContentResolver cr = getContext().getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.Downloads.DISPLAY_NAME, name);
        v.put(MediaStore.Downloads.MIME_TYPE, mime);
        v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) { call.reject("Não foi possível salvar."); return; }
        try (OutputStream out = cr.openOutputStream(uri)) {
            if (out == null) throw new IOException("sem saída");
            out.write(text.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            cr.delete(uri, null, null);
            call.reject("Não foi possível salvar: " + e.getMessage());
            return;
        }
        call.resolve();
    }

    // ---------------------------------------------------------------- utilidades

    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    @PluginMethod
    public void readClipboard(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = cm != null ? cm.getPrimaryClip() : null;
            String text = "";
            if (clip != null && clip.getItemCount() > 0) {
                CharSequence cs = clip.getItemAt(0).coerceToText(getContext());
                if (cs != null) text = cs.toString();
            }
            JSObject r = new JSObject();
            r.put("text", text);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", getContext().getPackageName(), null));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    // ---------------------------------------------------------------- atualização

    /** Só baixa APK das Releases DESTE repositório. */
    private static final String UPDATE_PREFIX = "https://github.com/gleibson-crn/teleprompter/releases/download/";

    private File updateFile() {
        return new File(new File(getContext().getCacheDir(), "updates"), "update.apk");
    }

    @PluginMethod
    public void appVersion(PluginCall call) {
        try {
            PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject r = new JSObject();
            r.put("name", pi.versionName);
            r.put("code", pi.getLongVersionCode());
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /**
     * Baixa o APK novo e abre o instalador do Android (o usuário só toca em Instalar).
     * App fora da loja não pode se instalar sem esse toque. O Android também recusa um
     * APK assinado com outra chave, então um arquivo trocado não substitui o app.
     */
    @PluginMethod
    public void installUpdate(PluginCall call) {
        final String url = call.getString("url", "");
        if (!url.startsWith(UPDATE_PREFIX) || !url.endsWith(".apk")) {
            call.reject("Endereço de atualização inválido.", "URL");
            return;
        }
        final Context ctx = getContext();
        if (!ctx.getPackageManager().canRequestPackageInstalls()) {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            call.reject("Ative \"Permitir desta fonte\" para o Teleprompter e volte ao app.", "PERMISSION");
            return;
        }
        new Thread(() -> {
            File apk = updateFile();
            //noinspection ResultOfMethodCallIgnored
            apk.getParentFile().mkdirs();
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                if (c.getResponseCode() != HttpURLConnection.HTTP_OK) throw new IOException("HTTP " + c.getResponseCode());
                try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                PackageInfo pi = ctx.getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
                if (pi == null || !ctx.getPackageName().equals(pi.packageName)) {
                    throw new IOException("o arquivo baixado não é o Teleprompter");
                }
                Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                call.resolve();
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                apk.delete();
                call.reject("Não foi possível baixar a atualização: " + e.getMessage(), "DOWNLOAD", e);
            } finally {
                if (c != null) c.disconnect();
            }
        }).start();
    }
}
