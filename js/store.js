// Persistência local (localStorage). Nada sai do aparelho.
const SCRIPTS_KEY = 'tp.scripts';
const SETTINGS_KEY = 'tp.settings';

export const DEFAULT_SETTINGS = {
  speed: 10,       // 1–40; px/s = speed * fontSize / 10
  fontSize: 48,    // px
  margin: 6,       // vw de cada lado
  guidePos: 35,    // % da altura da área de texto
  countdown: 3,    // segundos (0 = desligada)
  mirrorH: false,
  mirrorV: false,
  guide: true,
  center: false,
};

const SAMPLE = {
  title: 'Exemplo — como usar',
  text: `Bem-vindo ao Teleprompter!

Toque na tela para iniciar ou pausar a rolagem.

Arraste o texto para cima ou para baixo para ajustar a posição.

Use os botões − e + para mudar a velocidade, e a engrenagem para ajustar fonte, margens, espelhamento e a linha de leitura.

No modo Câmera, o texto fica no topo da tela, perto da lente, e o botão vermelho grava o vídeo sem o texto.

Um teclado ou pedal Bluetooth também funciona: espaço inicia ou pausa, setas para cima e para baixo mudam a velocidade, Page Up e Page Down saltam pelo texto.`,
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Armazenamento cheio ou bloqueado: segue em memória.
  }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let scripts = read(SCRIPTS_KEY, null);
if (!Array.isArray(scripts)) {
  scripts = [{ id: uid(), ...SAMPLE, updated: Date.now() }];
  write(SCRIPTS_KEY, scripts);
}

export function listScripts() {
  return [...scripts].sort((a, b) => b.updated - a.updated);
}

export function getScript(id) {
  return scripts.find((s) => s.id === id) || null;
}

export function createScript(title = '', text = '') {
  const s = { id: uid(), title, text, updated: Date.now() };
  scripts.push(s);
  write(SCRIPTS_KEY, scripts);
  return s;
}

export function updateScript(id, patch) {
  const s = getScript(id);
  if (!s) return;
  Object.assign(s, patch, { updated: Date.now() });
  write(SCRIPTS_KEY, scripts);
}

export function deleteScript(id) {
  scripts = scripts.filter((s) => s.id !== id);
  write(SCRIPTS_KEY, scripts);
}

export function exportScripts() {
  return JSON.stringify({ app: 'teleprompter', version: 1, scripts: scripts.map(({ title, text }) => ({ title, text })) }, null, 2);
}

/** Aceita o JSON exportado (ou uma lista simples de {title,text}). Retorna quantos entraram. */
export function importJson(raw) {
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : data?.scripts;
  if (!Array.isArray(list)) throw new Error('Formato não reconhecido');
  let n = 0;
  for (const item of list) {
    if (typeof item?.text !== 'string') continue;
    createScript(String(item.title || 'Sem título'), item.text);
    n++;
  }
  return n;
}

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...read(SETTINGS_KEY, {}) };
}

export function saveSettings(settings) {
  write(SETTINGS_KEY, settings);
}
