# Provador de tatuagem

**Abrir o app:** https://kevinsilva121.github.io/Ink/ (funciona no computador e no celular)

Protótipo web para ver como uma tatuagem fica no **seu** corpo antes de fazer: você escolhe uma foto do corpo e o desenho (do Pinterest, do tatuador ou extraído de outra foto), e o app ajusta a tatuagem à curva do braço, perna ou tronco, com luz e textura da pele. Tudo roda no aparelho: as fotos não são enviadas para nenhum servidor.

## O que já faz

- **Provar no corpo**: toca na foto e a tatuagem se ajusta ao membro (cilindro que afina e engrossa), recortada na pele, com a tinta "por baixo" do brilho da pele. Aspecto cicatrizada ou recém-feita.
- **Várias tatuagens** na mesma foto (fechamento).
- **Ajustes finos**: tamanho, giro, curvatura, cobertura da tinta, espelhar; "Ajustar lados" (encolher/esticar só um lado); "Ajustar contorno" (bordas do membro e onde ele termina, ex.: punho); borracha para o que está na frente da pele.
- **Voltar / Avançar** em qualquer edição.
- **Extrair de uma foto**: tira o desenho de uma tatuagem real (na pele de alguém) e deixa em fundo branco, com recorte livre ou "ímã" que gruda na borda e remoção de rebarbas.
- **Gerar decalque** em PDF no tamanho real, para qualquer parte do corpo: stencil do tatuador, papel de tatuagem temporária (espelhado) ou papel comum; divide em várias folhas A4 quando precisa.
- **Projetos** salvos sozinhos no aparelho, com exportação/importação de arquivo.

## Como rodar

Precisa do [Node.js](https://nodejs.org) 20 ou mais novo.

```bash
cd web
npm install
npm run dev
```

Abre em `http://localhost:5173` (e no celular, pelo endereço de rede que o Vite mostra, na mesma rede Wi-Fi).

Na primeira vez, `npm run dev` baixa os modelos de detecção do corpo do MediaPipe (segmentação de pele e pontos do corpo, ~50 MB) para `web/public/models` e copia o WebAssembly para `web/public/mediapipe`. Essas pastas não vão para o repositório.

Para gerar a versão de produção: `npm run build` (sai em `web/dist`).

## Publicação

Cada `git push` na `main` publica o app no GitHub Pages sozinho (`.github/workflows/pages.yml`): o GitHub instala, baixa os modelos, monta com o endereço `/Ink/` e publica. O andamento aparece na aba **Actions** do repositório; leva uns 2 minutos.

## Como funciona (resumo)

- `vision.ts`: MediaPipe (pele e pose), rodando no aparelho.
- `geometry.ts`: modelo do membro (eixo, centro e raio ao longo do eixo, ajuste robusto às bordas da pele) e as correções manuais.
- `render.ts`: enrola o desenho no membro e mistura com a pele (multiplicação, brilho, cobertura).
- `extract.ts` / `extractor.ts` / `magnet.ts`: extração do desenho de uma foto (foto ÷ pele), recorte ímã e rebarbas.
- `decal.ts`: decalque em escala real e o PDF.
- `store.ts`: projetos no IndexedDB.

Status: protótipo de teste.
