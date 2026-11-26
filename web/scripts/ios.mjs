// Projeto do iPhone (pasta ios/): gerado no Mac pelo Capacitor, com CocoaPods, e com o que o
// Provink precisa por cima (ícone, abertura, permissões, idioma, barra de status, versão).
// A pasta ios/ não fica no repositório: dá para apagar e gerar de novo a qualquer momento.
//
//   npm run ios          gera a pasta (se não existir), atualiza o app dentro dela e abre o Xcode
//   npm run ios:novo     apaga a pasta ios/ e gera do zero (ex.: depois de atualizar o Capacitor)
//
// Opções do script: --novo (apaga e gera de novo), --abrir (abre o Xcode no fim).
import { execSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ios = join(root, 'ios');
const app = join(ios, 'App');
const args = new Set(process.argv.slice(2));
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

if (!existsSync(join(root, 'dist', 'index.html'))) {
  console.error('Falta montar o app antes: rode "npm run build" (os scripts npm run ios já fazem isso).');
  process.exit(1);
}

if (args.has('--novo') && existsSync(ios)) {
  console.log('Apagando a pasta ios/ para gerar de novo…');
  rmSync(ios, { recursive: true, force: true });
}

if (!existsSync(ios)) {
  console.log('Gerando a pasta ios/ (Capacitor, com CocoaPods)…');
  run('npx cap add ios --packagemanager CocoaPods');
} else if (existsSync(join(app, 'CapApp-SPM'))) {
  console.error('A pasta ios/ é de um projeto antigo (sem CocoaPods). Rode "npm run ios:novo" para gerar de novo.');
  process.exit(1);
}

// ---------- Ajustes do Provink no projeto gerado ----------
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const build = String(pkg.buildNumber ?? 1);

// Ícone (a rosa) e a abertura (a rosa no fundo preto): web/native/ios/Assets.xcassets.
for (const set of ['AppIcon.appiconset', 'Splash.imageset']) {
  const to = join(app, 'App', 'Assets.xcassets', set);
  rmSync(to, { recursive: true, force: true });
  cpSync(join(root, 'native', 'ios', 'Assets.xcassets', set), to, { recursive: true });
}

// Info.plist: textos das permissões, nome, idioma, barra de status e criptografia.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const str = (s) => `<string>${esc(s)}</string>`;
const plistPath = join(app, 'App', 'Info.plist');
let plist = readFileSync(plistPath, 'utf8');
const setKey = (key, value) => {
  const re = new RegExp(`(<key>${key}</key>\\s*)(<string>[\\s\\S]*?</string>|<true\\s*/>|<false\\s*/>)`);
  plist = re.test(plist) ? plist.replace(re, `$1${value}`) : plist.replace('<dict>', `<dict>\n\t<key>${key}</key>\n\t${value}`);
};
setKey('CFBundleDisplayName', str('Provink'));
setKey('NSCameraUsageDescription', str('O Provink usa a câmera para você tirar a foto do corpo (ou da tatuagem) na hora. A foto fica só no seu aparelho.'));
setKey('NSPhotoLibraryUsageDescription', str('O Provink abre as suas fotos para você escolher a foto do corpo e o desenho da tatuagem. Nada é enviado para servidor.'));
setKey('NSPhotoLibraryAddUsageDescription', str('O Provink salva nas suas fotos a imagem com a tatuagem quando você pede.'));
// Janelas do sistema (fototeca, câmera, compartilhar) em português.
setKey('CFBundleDevelopmentRegion', str('pt-BR'));
setKey('CFBundleAllowMixedLocalizations', '<true/>');
// Relógio e bateria em branco sobre o topo escuro do app.
setKey('UIStatusBarStyle', str('UIStatusBarStyleLightContent'));
setKey('UIViewControllerBasedStatusBarAppearance', '<false/>');
// Sem criptografia própria (só a do sistema): o App Store Connect não pergunta a cada versão.
setKey('ITSAppUsesNonExemptEncryption', '<false/>');
writeFileSync(plistPath, plist);

// Versão (package.json "version") e número da build (package.json "buildNumber").
const pbxPath = join(app, 'App.xcodeproj', 'project.pbxproj');
let pbx = readFileSync(pbxPath, 'utf8');
pbx = pbx.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`);
pbx = pbx.replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`);
writeFileSync(pbxPath, pbx);
console.log(`Projeto do iPhone ajustado: versão ${version} (build ${build}).`);

// Copia o app montado e instala os pods (no Mac, com o CocoaPods instalado).
run('npx cap sync ios');

if (args.has('--abrir')) run('npx cap open ios');
