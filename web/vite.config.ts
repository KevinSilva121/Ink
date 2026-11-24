import { defineConfig, type Plugin } from 'vite';

/**
 * Privacidade: o app só busca arquivos dele mesmo. A regra de segurança abaixo bloqueia
 * qualquer conexão para fora, inclusive as estatísticas de uso que a biblioteca do MediaPipe
 * manda para o Google (odml.pa.googleapis.com). Assim o app declara nas lojas que não coleta
 * dados. Só no build: o servidor de desenvolvimento usa uma conexão própria para recarregar.
 */
const noExternalConnections = (): Plugin => ({
  name: 'provink-sem-conexoes-externas',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="connect-src 'self' data: blob:" />`),
});

// No GitHub Pages o site fica em /<nome-do-repositório>/ (ex.: /Ink/): o fluxo de publicação
// passa esse caminho em BASE_PATH. No computador e no app, fica na raiz.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [noExternalConnections()],
});
