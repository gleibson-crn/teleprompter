// Roteamento por hash + telas de lista e editor + ajustes + service worker.
import { icon } from './icons.js';
import * as store from './store.js';
import { createPrompter } from './prompter.js';

const $ = (id) => document.getElementById(id);

// Ícones dos botões por ação (e spans com data-icon)
const ACTION_ICONS = {
  import: 'upload', export: 'download', new: 'plus', back: 'arrow-left', duplicate: 'copy',
  delete: 'trash-2', close: 'x', restart: 'rotate-ccw', slower: 'minus', faster: 'plus',
  toggle: 'play', settings: 'settings', 'settings-close': 'x', record: 'video',
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
    setSetting(input.dataset.setting, input.type === 'checkbox' ? input.checked : Number(input.value));
  });
}

const prompter = createPrompter({ getSettings, setSetting, toast });

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
window.addEventListener('popstate', () => {
  // "Voltar" do Android durante a gravação: confirma antes de perder o vídeo.
  if (prompter.isRecording() && !confirm('Parar a gravação e sair?')) {
    history.pushState({ d: (history.state?.d || 0) + 1 }, '', lastHash);
    return;
  }
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
  duplicate: () => {
    flushSave();
    const s = store.getScript(currentId);
    const copy = store.createScript(`${s.title || 'Sem título'} (cópia)`, s.text);
    history.replaceState(history.state, '', `#/edit/${copy.id}`);
    render();
    toast('Roteiro duplicado.');
  },
  delete: () => {
    if (!confirm('Excluir este roteiro? Não dá para desfazer.')) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    store.deleteScript(currentId);
    back('#/');
  },
  play: () => { flushSave(); go(`#/play/${currentId}`); },
  camera: () => { flushSave(); go(`#/cam/${currentId}`); },
  close: () => {
    if (prompter.isRecording() && !confirm('Parar a gravação e sair?')) return;
    back(`#/edit/${currentId}`);
  },
  toggle: () => prompter.toggle(),
  restart: () => prompter.restart(),
  slower: () => prompter.changeSpeed(-1),
  faster: () => prompter.changeSpeed(1),
  record: () => prompter.toggleRecording(),
  settings: () => { syncSettingsForm(); $('settings').hidden = false; },
  'settings-close': () => { $('settings').hidden = true; },
  'rec-save': () => prompter.saveRecording(),
  'rec-share': () => prompter.shareRecording(),
  'rec-discard': () => { if (confirm('Descartar esta gravação?')) prompter.discardRecording(); },
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
