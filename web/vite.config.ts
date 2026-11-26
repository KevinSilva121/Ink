import { defineConfig, type Plugin } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

// Versão (tela "Sobre"): a do package.json, a data em que o app foi montado e o código do
// commit (para saber exatamente qual versão alguém está usando).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
let commit = '';
try {
  commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch {
  // Sem git (ex.: cópia sem histórico): fica sem o código.
}

// No GitHub Pages o site fica em /<nome-do-repositório>/ (ex.: /Ink/): o fluxo de publicação
// passa esse caminho em BASE_PATH. No computador e no app, fica na raiz.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [noExternalConnections()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
    __BUILD_COMMIT__: JSON.stringify(commit),
  },
});
