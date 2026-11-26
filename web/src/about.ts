// Tela "Sobre": o app, a versão (montada junto com o app) e a empresa.
import { platform } from './platform';

const dlg = document.getElementById('about') as HTMLDialogElement;
const set = (id: string, text: string) => (document.getElementById(id)!.textContent = text);

const built = new Date(__BUILD_DATE__);
set('aVersion', __APP_VERSION__);
set('aDate', built.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }));
set('aWhere', platform === 'android' ? 'App para Android' : platform === 'ios' ? 'App para iPhone' : 'Site (navegador)');
set('aBuild', __BUILD_COMMIT__);
document.getElementById('aBuildRow')!.hidden = !__BUILD_COMMIT__;
set('aCopy', `© ${built.getFullYear()} Innovate Apps Co. Todos os direitos reservados.`);

for (const b of document.querySelectorAll<HTMLElement>('[data-about]')) {
  b.addEventListener('click', () => {
    if (!dlg.open) dlg.showModal();
    dlg.scrollTop = 0;
  });
}
document.getElementById('aClose')!.addEventListener('click', () => dlg.close());
