import type { CapacitorConfig } from '@capacitor/cli';

// App nativo (Android e iOS): o mesmo app web, montado em dist/, dentro de um app de verdade.
const config: CapacitorConfig = {
  // Identificador nas lojas: não pode mudar depois de publicado.
  appId: 'com.provink.app',
  appName: 'Provink',
  webDir: 'dist',
  android: {
    // Fotos e desenhos chegam pelo seletor de arquivos/câmera do próprio Android.
    allowMixedContent: false,
  },
  ios: {
    // O app cuida das áreas seguras (entalhe, barra de início) pelo CSS.
    contentInset: 'never',
  },
};

export default config;
