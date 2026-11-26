import type { CapacitorConfig } from '@capacitor/cli';

// App nativo (Android e iOS): o mesmo app web, montado em dist/, dentro de um app de verdade.
const config: CapacitorConfig = {
  // Identificador nas lojas: não pode mudar depois de publicado.
  appId: 'com.provink.app',
  appName: 'Provink',
  webDir: 'dist',
  // Fundo escuro do app por trás da página: sem clarão branco ao abrir nem faixa branca ao
  // puxar a página além da borda (no iPhone a página "estica" no começo e no fim).
  backgroundColor: '#121316',
  android: {
    // Fotos e desenhos chegam pelo seletor de arquivos/câmera do próprio Android.
    allowMixedContent: false,
  },
  plugins: {
    // Abertura do sistema (a rosa no preto): fica até a página pôr a rosa dela no mesmo lugar
    // (script do index.html chama SplashScreen.hide) e se dissolve nela, sem tela preta no meio.
    // A mesma duração está no index.html (FADE).
    SplashScreen: {
      launchAutoHide: false,
      launchFadeOutDuration: 300,
      backgroundColor: '#050505',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
    },
  },
  ios: {
    // O app cuida das áreas seguras (entalhe, barra de início) pelo CSS.
    contentInset: 'never',
  },
};

export default config;
