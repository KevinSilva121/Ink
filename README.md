# Provink

**Abrir no navegador:** https://kevinsilva121.github.io/Ink/ (computador e celular)

Provink é um provador de tatuagem: você escolhe uma foto do corpo e o desenho (do Pinterest, do tatuador ou extraído de outra foto), e o app ajusta a tatuagem à curva do braço, perna ou tronco, com luz e textura da pele. Tudo roda no aparelho: as fotos não são enviadas para nenhum servidor, e o app não coleta dados.

Roda como site (GitHub Pages) e como app para Android e iOS (Capacitor), com o mesmo código.

## O que já faz

- **Provar no corpo**: toca na foto e a tatuagem se ajusta ao membro (cilindro que afina e engrossa), recortada na pele, com a tinta "por baixo" do brilho da pele. Aspecto cicatrizada ou recém-feita.
- **Várias tatuagens** na mesma foto (fechamento).
- **Ajustes finos**: tamanho, giro, curvatura, cobertura da tinta, espelhar; "Ajustar lados" (encolher/esticar só um lado); "Ajustar contorno" (bordas do membro e onde ele termina, ex.: punho); borracha para o que está na frente da pele.
- **Voltar / Avançar** em qualquer edição.
- **Extrair de uma foto**: tira o desenho de uma tatuagem real (na pele de alguém) e deixa em fundo branco, com recorte livre ou "ímã" que gruda na borda e remoção de rebarbas.
- **Gerar decalque** em PDF no tamanho real, para qualquer parte do corpo: stencil do tatuador, papel de tatuagem temporária (espelhado) ou papel comum; divide em várias folhas A4 quando precisa.
- **Projetos** salvos sozinhos no aparelho, com arquivo de projeto para guardar ou passar para outro aparelho.

## Rodar no computador

Precisa do [Node.js](https://nodejs.org) 20 ou mais novo.

```bash
cd web
npm install
npm run dev
```

Abre em `http://localhost:5173` (e no celular, pelo endereço de rede que o Vite mostra, na mesma rede Wi-Fi).

Na primeira vez, `npm run dev` baixa os modelos de detecção do corpo do MediaPipe (segmentação de pele e pontos do corpo, ~50 MB) para `web/public/models` e copia o WebAssembly para `web/public/mediapipe`. Essas pastas não vão para o repositório.

## Apps (Android e iOS)

O app nativo é o mesmo app web dentro de um app de verdade ([Capacitor](https://capacitorjs.com)). Identificador: `com.provink.app`.

- `web/android/`: projeto Android (abre no Android Studio).
- `web/ios/`: projeto iOS. **Não fica no repositório**: é gerado no Mac com `npm run ios` (ver "iPhone" abaixo).
- `web/native/ios/`: ícone e abertura do iPhone, copiados para o projeto gerado.
- `web/src/platform.ts`: o que muda entre site e app (salvar/compartilhar arquivos, botão voltar do Android).
- `web/assets/`: ícone e tela de abertura de origem. Depois de trocar, rode `npx @capacitor/assets generate --android --ios` (com a pasta `ios` gerada) e copie `AppIcon.appiconset` e `Splash.imageset` de `web/ios/App/App/Assets.xcassets` para `web/native/ios/Assets.xcassets`.

**Versão:** num lugar só, `web/package.json`: `version` (ex.: 1.0.0) e `buildNumber` (aumente a cada envio para as lojas). Vale para o site (tela "Sobre"), o Android e o iPhone.

**APK de teste sem instalar nada:** cada push na `main` monta o APK no GitHub (`.github/workflows/apps.yml`). Em **Actions → "Apps (Android e iOS)" → a execução mais recente → Artifacts**, baixe `provink-android-teste`, passe o `app-debug.apk` para o celular e instale (o Android pede para permitir "instalar apps desconhecidos"). O mesmo fluxo compila o projeto do iPhone num Mac, para garantir que ele está ok.

**Montar no computador (Android):** precisa do Android Studio e do Java 21.

```bash
cd web
npm run app:sync        # monta o app web e copia para o projeto Android
cd android
./gradlew assembleDebug # APK em android/app/build/outputs/apk/debug/
```

Ou `npm run app:android` para abrir no Android Studio (em Settings → Build Tools → Gradle, use o JDK 21).

**iPhone:** só compila no macOS. Precisa do Xcode, do Node.js 22 e do CocoaPods (`brew install cocoapods`).

```bash
cd web
npm ci
npm run ios        # gera web/ios se não existir, aplica ícone, abertura, permissões e versão,
                   # instala os pods e abre o Xcode
npm run ios:novo   # apaga web/ios e gera do zero (ex.: depois de atualizar o Capacitor)
```

No Xcode (abre o `App.xcworkspace`, não o `.xcodeproj`): **Signing & Capabilities → Team** com a sua conta Apple, escolha o iPhone e ▶. Para atualizar depois: `git pull` e `npm run ios` de novo. Para publicar: conta Apple Developer paga, **Product → Archive → Distribute App → App Store Connect** e testes pelo TestFlight.

## Publicação do site

Cada `git push` na `main` publica o site no GitHub Pages sozinho (`.github/workflows/pages.yml`): o GitHub instala, baixa os modelos, monta com o endereço `/Ink/` e publica. O andamento aparece na aba **Actions** do repositório; leva uns 2 minutos.

## Privacidade

As fotos, os desenhos e os projetos ficam só no aparelho. A biblioteca do MediaPipe tenta mandar estatísticas de uso para o Google; o app bloqueia isso com uma regra de segurança da página (`connect-src 'self'`, em `web/vite.config.ts`), então nenhuma conexão sai do app.

## Como funciona (resumo)

- `vision.ts`: MediaPipe (pele e pose), rodando no aparelho.
- `geometry.ts`: modelo do membro (eixo, centro e raio ao longo do eixo, ajuste robusto às bordas da pele) e as correções manuais.
- `render.ts`: enrola o desenho no membro e mistura com a pele (multiplicação, brilho, cobertura).
- `extract.ts` / `extractor.ts` / `magnet.ts`: extração do desenho de uma foto (foto ÷ pele), recorte ímã e rebarbas.
- `decal.ts`: decalque em escala real e o PDF.
- `store.ts`: projetos (IndexedDB no site; arquivos do app no Android/iOS).
- `platform.ts`: ponte entre site e app.

Status: beta.
