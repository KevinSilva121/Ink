package com.provink.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Plugins do próprio app: registrar antes de criar a ponte.
        registerPlugin(TelaPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
