package io.github.gleibsoncrn.teleprompter;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugin local (câmera/gravação nativas) — registrado antes do bridge subir.
        registerPlugin(TeleprompterCameraPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
