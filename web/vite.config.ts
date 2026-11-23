import { defineConfig } from 'vite';

// No GitHub Pages o site fica em /<nome-do-repositório>/ (ex.: /Ink/): o fluxo de publicação
// passa esse caminho em BASE_PATH. Rodando no computador, fica na raiz.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
});
