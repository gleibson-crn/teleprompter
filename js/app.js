// Roteamento por hash + telas de lista e editor + ajustes + service worker.
import { icon } from './icons.js';
import * as store from './store.js';
import { createPrompter } from './prompter.js';

const $ = (id) => document.getElementById(id);

// Ícones dos botões por ação (e spans com data-icon)
const ACTION_ICONS = {
  import: 'upload', export: 'download', new: 'plus', back: 'arrow-left', paste: 'clipboard-paste',
  delete: 'trash-2', close: 'x', restart: 'rotate-ccw', slower: 'minus', faster: 'plus',
  toggle: 'play', settings: 'settings', 'settings-close': 'x', record: 'video',
  av: 'sliders-horizontal', 'av-close': 'x',
};
for (const btn of document.querySelectorAll('[data-action]')) {
  const name = ACTION_ICONS[btn.dataset.action];
  if (name && !btn.querySelector('[data-icon]')) btn.innerHTML = icon(name);
}
for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);

// ---------- Toast ----------
let toastTimer = 0;
function toast(msg, { onClick, sticky = false } = {}) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.toggle('clickable', !!onClick);
  el.onclick = onClick || null;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// ---------- Confirmação (diálogo do app, no lugar do confirm() do navegador) ----------
// Esc, "voltar" do Android e toque fora do cartão = Cancelar.
const askDialog = $('ask');
askDialog.addEventListener('click', (e) => { if (e.target === askDialog) askDialog.close(); });
function ask({ title, message = '', ok, icon: ico = 'trash-2' }) {
  $('ask-title').textContent = title;
  $('ask-msg').textContent = message;
  $('ask-ico').innerHTML = icon(ico);
  $('ask-ok').textContent = ok;
  askDialog.returnValue = '';
  askDialog.showModal();
  return new Promise((resolve) => {
    askDialog.addEventListener('close', () => resolve(askDialog.returnValue === 'ok'), { once: true });
  });
}
const askStopRecording = () => ask({
  title: 'Parar a gravação e sair?', message: 'O vídeo que está sendo gravado será perdido.', ok: 'Parar e sair', icon: 'square',
});

// ---------- Ajustes ----------
let settings = store.loadSettings();
const getSettings = () => settings;
function setSetting(key, value) {
  settings = { ...settings, [key]: value };
  store.saveSettings(settings);
  syncSettingsForm();
  prompter.applySettings();
}

const FORMAT = {
  speed: (v) => v,
  fontSize: (v) => v + ' px',
  margin: (v) => v + '%',
  guidePos: (v) => v + '%',
  countdown: (v) => (v ? v + ' s' : 'desligada'),
  gainDb: (v) => (v ? '+' + v + ' dB' : '0 dB'),
};
function syncSettingsForm() {
  for (const input of document.querySelectorAll('[data-setting]')) {
    const key = input.dataset.setting;
    if (input.type === 'checkbox') input.checked = !!settings[key];
    else input.value = settings[key];
    const out = document.querySelector(`[data-out="${key}"]`);
    if (out) out.textContent = FORMAT[key](settings[key]);
  }
}
for (const input of document.querySelectorAll('[data-setting]')) {
  input.addEventListener('input', () => {
    const v = input.type === 'checkbox' ? input.checked
      : input.tagName === 'SELECT' && !('number' in input.dataset) ? input.value
      : Number(input.value);
    setSetting(input.dataset.setting, v);
  });
}

const prompter = createPrompter({ getSettings, setSetting, toast });
// Leitura de estado para diagnóstico/testes automatizados (somente leitura).
globalThis.__teleprompter = { debug: prompter.debug };

// ---------- Navegação ----------
// history.state.d = profundidade dentro do app, para o "voltar" não sair do PWA.
function go(hash) {
  history.pushState({ d: (history.state?.d || 0) + 1 }, '', hash);
  render();
}
function back(fallback = '#/') {
  if (history.state?.d > 0) history.back();
  else { history.replaceState({ d: 0 }, '', fallback); render(); }
}
let lastHash = location.hash;
let leaving = false; // saída já confirmada: o próximo popstate não pergunta de novo
async function leavePrompter() {
  if (prompter.isRecording() && !(await askStopRecording())) return;
  leaving = true;
  back(`#/edit/${currentId}`);
}
window.addEventListener('popstate', () => {
  // "Voltar" do Android durante a gravação: fica na tela e confirma antes de perder o vídeo.
  if (!leaving && prompter.isRecording()) {
    history.pushState({ d: (history.state?.d || 0) + 1 }, '', lastHash);
    leavePrompter();
    return;
  }
  leaving = false;
  render();
});

const VIEWS = ['view-list', 'view-edit', 'view-prompter'];
function show(id) {
  for (const v of VIEWS) $(v).hidden = v !== id;
}

let currentId = null;

function render() {
  lastHash = location.hash;
  const [, route, id] = (location.hash || '#/').split('/');
  if (route !== 'play' && route !== 'cam') prompter.close();
  const script = id ? store.getScript(id) : null;

  if ((route === 'edit' || route === 'play' || route === 'cam') && !script) {
    history.replaceState({ d: 0 }, '', '#/');
    return render();
  }
  currentId = script?.id || null;

  if (route === 'edit') {
    $('edit-title').value = script.title;
    $('edit-text').value = script.text;
    textTouched = false;
    updateStats();
    show('view-edit');
  } else if (route === 'play' || route === 'cam') {
    show('view-prompter');
    prompter.open(script, { camera: route === 'cam' });
  } else {
    renderList();
    show('view-list');
  }
}

// ---------- Lista ----------
function renderList() {
  const items = store.listScripts();
  const ul = $('script-list');
  ul.replaceChildren(...items.map((s) => {
    const li = document.createElement('li');
    li.className = 'script-item';
    const h = document.createElement('h3');
    h.textContent = s.title || 'Sem título';
    const p = document.createElement('p');
    p.textContent = s.text.trim() || 'Vazio';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${stats(s.text)} · editado ${new Date(s.updated).toLocaleDateString('pt-BR')}`;
    li.append(h, p, meta);
    li.onclick = () => go(`#/edit/${s.id}`);
    return li;
  }));
  $('empty-list').hidden = items.length > 0;
}

// ---------- Editor ----------
function stats(text) {
  const words = (text.match(/\S+/g) || []).length;
  const secs = Math.round(words / 2.5); // ~150 palavras/min
  return `${words} palavra${words === 1 ? '' : 's'} · ~${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}
function updateStats() {
  $('edit-stats').textContent = stats($('edit-text').value);
}

let saveTimer = 0;
function scheduleSave() {
  const id = currentId;
  const patch = { title: $('edit-title').value, text: $('edit-text').value };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.updateScript(id, patch), 300);
}
function flushSave() {
  if (!saveTimer || !currentId) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  store.updateScript(currentId, { title: $('edit-title').value, text: $('edit-text').value });
}
$('edit-title').addEventListener('input', scheduleSave);
$('edit-text').addEventListener('input', () => { updateStats(); scheduleSave(); });
// O usuário já posicionou o cursor no texto? (senão o Colar vai para o fim)
let textTouched = false;
$('edit-text').addEventListener('focus', () => { textTouched = true; });
window.addEventListener('pagehide', flushSave);

// ---------- Importar / exportar ----------
function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

$('import-input').addEventListener('change', async (e) => {
  let n = 0;
  for (const file of e.target.files) {
    const raw = await file.text();
    try {
      if (file.name.toLowerCase().endsWith('.json')) n += store.importJson(raw);
      else { store.createScript(file.name.replace(/\.[^.]+$/, ''), raw); n++; }
    } catch {
      toast(`Não consegui ler ${file.name}.`);
    }
  }
  e.target.value = '';
  if (n) toast(`${n} roteiro${n === 1 ? '' : 's'} importado${n === 1 ? '' : 's'}.`);
  renderList();
});

// ---------- Ações ----------
const ACTIONS = {
  new: () => { const s = store.createScript(); go(`#/edit/${s.id}`); setTimeout(() => $('edit-text').focus(), 50); },
  import: () => $('import-input').click(),
  export: () => download(`teleprompter-roteiros-${new Date().toISOString().slice(0, 10)}.json`, store.exportScripts(), 'application/json'),
  back: () => { flushSave(); back('#/'); },
  // Cola a área de transferência no texto: no cursor, ou no fim se ainda não tocou no texto.
  paste: async () => {
    const ta = $('edit-text');
    let clip = '';
    try {
      clip = await navigator.clipboard.readText();
    } catch {
      toast('Sem acesso à área de transferência. Toque e segure no texto e escolha Colar.');
      return;
    }
    if (!clip) { toast('A área de transferência está vazia.'); return; }
    if (!textTouched) {
      if (ta.value && !ta.value.endsWith('\n')) clip = '\n' + clip;
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    ta.focus();
    ta.setRangeText(clip, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input'));
    toast('Texto colado.');
  },
  delete: async () => {
    if (!(await ask({ title: 'Excluir este roteiro?', message: 'Não dá para desfazer.', ok: 'Excluir' }))) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    store.deleteScript(currentId);
    back('#/');
  },
  play: () => { flushSave(); go(`#/play/${currentId}`); },
  camera: () => { flushSave(); go(`#/cam/${currentId}`); },
  close: () => leavePrompter(),
  toggle: () => prompter.toggle(),
  restart: () => prompter.restart(),
  slower: () => prompter.changeSpeed(-1),
  faster: () => prompter.changeSpeed(1),
  record: () => prompter.toggleRecording(),
  settings: () => { prompter.closeAv(); syncSettingsForm(); $('settings').hidden = false; },
  'settings-close': () => { $('settings').hidden = true; },
  av: () => { syncSettingsForm(); prompter.openAv(); },
  'av-close': () => prompter.closeAv(),
  'mic-test': () => prompter.testMic(),
  diag: () => prompter.runDiag(),
  'diag-copy': () => prompter.copyDiag(),
  'mic-play-raw': () => prompter.playTest('raw'),
  'mic-play-processed': () => prompter.playTest('processed'),
  'rec-save': () => prompter.saveRecording(),
  'rec-share': () => prompter.shareRecording(),
  'rec-show-h': () => prompter.showFormat('h'),
  'rec-show-v': () => prompter.showFormat('v'),
  'rec-discard': async () => {
    if (await ask({ title: 'Descartar esta gravação?', message: 'O vídeo será apagado e não dá para recuperar.', ok: 'Descartar' })) prompter.discardRecording();
  },
};
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (btn) ACTIONS[btn.dataset.action]?.();
});

// ---------- Service worker (offline + aviso de nova versão) ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Nova versão disponível — toque para atualizar.', {
            sticky: true,
            onClick: () => { updating = true; sw.postMessage('skipWaiting'); },
          });
        }
      });
    });
  }).catch(() => {});
  // Só recarrega quando o usuário pediu a atualização (a 1ª instalação também troca o controller).
  let updating = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updating) return;
    updating = false;
    location.reload();
  });
}

if (!history.state) history.replaceState({ d: 0 }, '', location.hash || '#/');
render();
