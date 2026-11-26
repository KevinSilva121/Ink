package com.provink.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Onde a página (o WebView) começa na tela, em pixels da tela. A abertura do sistema centraliza a
 * rosa na tela inteira, e a página começa abaixo da barra de status: a abertura da página usa isto
 * para pôr a rosa dela exatamente em cima da do sistema (index.html).
 */
@CapacitorPlugin(name = "Tela")
public class TelaPlugin extends Plugin {

    @PluginMethod
    public void posicao(PluginCall call) {
        getActivity()
            .runOnUiThread(() -> {
                int[] xy = new int[2];
                getBridge().getWebView().getLocationOnScreen(xy);
                JSObject r = new JSObject();
                r.put("x", xy[0]);
                r.put("y", xy[1]);
                call.resolve(r);
            });
    }
}
