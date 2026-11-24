// Ponte entre o app e o lugar onde ele roda: navegador (site) ou app instalado (Android/iOS,
// via Capacitor). O resto do código chama só estas funções e não precisa saber onde está.
import { Capacitor } from '@capacitor/core';

/** Rodando como app instalado (Android ou iOS)? */
export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform() as 'web' | 'android' | 'ios';

/** Arquivo do app: pode ser compartilhado (WhatsApp, Arquivos, imprimir...) ou baixado. */
export async function saveFile(blob: Blob, filename: string, title = filename): Promise<void> {
  if (!isNative) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return;
  }
  // No app não existe "baixar": grava numa pasta temporária do app e abre o menu de
  // compartilhar do celular (de lá dá para salvar em Arquivos, mandar ou imprimir).
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
  const res = await Filesystem.writeFile({
    path: `compartilhar/${filename}`,
    data: await blobToBase64(blob),
    directory: Directory.Cache,
    recursive: true,
  });
  try {
    await Share.share({ title, files: [res.uri], dialogTitle: title });
  } catch (err) {
    // Fechar o menu sem escolher nada não é erro.
    if (!/cancel/i.test(String((err as Error)?.message ?? err))) throw err;
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Botão "voltar" do Android: quem registra decide o que fechar (uma tela, um modo).
 * Devolve true se fechou algo; se nada estiver aberto, o app vai para o fundo.
 */
export function onBackButton(handler: () => boolean) {
  if (platform !== 'android') return;
  void import('@capacitor/app').then(({ App }) =>
    App.addListener('backButton', () => {
      if (!handler()) void App.minimizeApp();
    }),
  );
}
