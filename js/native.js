// Ponte com o APK (Capacitor). No navegador/PWA nada daqui é usado: isNative = false.
// No APK, câmera, preview e gravação são NATIVOS (plugin TeleprompterCamera, CameraX com
// codificador de vídeo por hardware); o preview fica atrás da página, que fica transparente.

const Cap = globalThis.Capacitor;
export const isNative = !!Cap?.isNativePlatform?.();
export const NativeCam = isNative
  ? (Cap.registerPlugin ? Cap.registerPlugin('TeleprompterCamera') : Cap.Plugins.TeleprompterCamera)
  : null;
/** URL que a página consegue tocar para um arquivo do aparelho. */
export const fileUrl = (path) => Cap.convertFileSrc(path);

if (isNative) document.documentElement.dataset.native = '';

// Mudou alguma destas → precisa reabrir a câmera.
const keyOf = (s) => [s.facing, s.res, s.fps, s.vertical, s.follow].join('|');

/**
 * Captura nativa com a MESMA interface de createCapture (js/capture.js), para o
 * teleprompter não precisar saber de onde vem a câmera. O que é só da web (áudio tratado,
 * Vertical inteligente, diagnóstico) responde vazio aqui e fica escondido no APK.
 */
const landscape = () => innerWidth > innerHeight;

function setOptionDisabled(setting, value, disabled) {
  const opt = document.querySelector(`select[data-setting="${setting}"] option[value="${value}"]`);
  if (opt) opt.disabled = disabled;
}

export function createNativeCapture({ video, getSettings, setSetting, toast, ask, onFinished, onReframe = () => {} }) {
  let open = false;
  let key = '';
  let info = null;
  let zoom = 1;
  // Vertical inteligente: centro do recorte (0..1 no quadro do ARQUIVO) vindo do detector nativo.
  const rf = { on: false, follow: false, center: 0.5, faces: 0, updates: 0 };

  NativeCam.addListener('recordingFinished', (r) => onFinished(r));
  NativeCam.addListener('reframe', ({ c, faces }) => {
    rf.center = c;
    rf.faces = faces;
    rf.updates++;
    onReframe();
  });

  async function start() {
    let perm = await NativeCam.checkPermissions();
    if (perm.camera !== 'granted' || perm.microphone !== 'granted') {
      perm = await NativeCam.requestPermissions({ permissions: ['camera', 'microphone'] });
    }
    if (perm.camera !== 'granted') {
      const go = await ask({
        title: 'Permitir a câmera?',
        message: 'O Teleprompter precisa da câmera para gravar. Libere em Permissões nos ajustes do app.',
        ok: 'Abrir ajustes',
        icon: 'camera',
      });
      if (go) NativeCam.openSettings();
      return false;
    }
    if (perm.microphone !== 'granted') toast('Sem permissão do microfone: o vídeo vai sair sem som.');
    const s = getSettings();
    try {
      info = await NativeCam.startPreview({ facing: s.facing, quality: s.res, fps: s.fps, vertical: !!s.vertical, follow: s.follow !== false });
    } catch (e) {
      toast('Não foi possível abrir a câmera: ' + (e?.message || e));
      return false;
    }
    zoom = info.zoom || 1;
    rf.on = !!s.vertical;
    rf.follow = !!info.follow && s.follow !== false;
    rf.center = 0.5;
    if (s.vertical && s.follow !== false && !info.follow) toast('Este aparelho não consegue seguir o rosto junto com a gravação — recorte no centro.');
    // Trava no seletor o que ESTA câmera não grava (a frontal do moto g41 para em 720p).
    const lado = s.facing === 'environment' ? 'traseira' : 'frontal';
    const no1080 = !!info.maxHeight && info.maxHeight < 1080;
    const no60 = !info.fps60;
    setOptionDisabled('res', 1080, no1080);
    setOptionDisabled('fps', 60, no60);
    if (no1080 && s.res > info.maxHeight) {
      setSetting('res', 720);
      toast(`A câmera ${lado} deste celular grava até 720p — ajustado para 720p.`);
    }
    if (no60 && s.fps > 30) {
      setSetting('fps', 30);
      toast(`A câmera ${lado} deste celular grava até 30 fps — ajustado para 30.`);
    }
    // O <video> não toca nada: só ocupa a área do preview (grade/guia se posicionam por ele).
    video.hidden = false;
    document.documentElement.classList.add('native-cam');
    key = keyOf(getSettings());
    open = true;
    return true;
  }

  function stop() {
    if (!open) return;
    open = false;
    key = '';
    rf.on = false;
    document.documentElement.classList.remove('native-cam');
    video.hidden = true;
    NativeCam.stopPreview().catch(() => {});
  }

  function controls() {
    if (!info || !(info.zoomMax > info.zoomMin)) return [];
    return [{
      name: 'zoom', label: 'Zoom', type: 'range',
      min: info.zoomMin, max: Math.min(info.zoomMax, 10), step: 0.1, value: zoom,
      fmt: (v) => `${(+v).toFixed(1)}×`,
    }];
  }

  async function setControl(name, value) {
    if (name !== 'zoom') return;
    zoom = +value;
    try { await NativeCam.setZoom({ ratio: zoom }); } catch { toast('O aparelho recusou esse ajuste.'); }
  }

  /** Tamanho do quadro como aparece na tela (para a grade e a guia 9:16). */
  function videoSize() {
    const h = getSettings().res >= 1080 ? 1080 : 720;
    const w = Math.round((h * 16) / 9);
    return innerWidth > innerHeight ? { w, h } : { w: h, h: w };
  }

  return {
    native: true,
    start,
    stop,
    active: () => open,
    needsRestart: () => open && keyOf(getSettings()) !== key,
    applyAudio: () => {},
    resumeAudio: async () => {},
    level: () => null,
    controls,
    setControl,
    listMics: async () => [],
    testMic: async () => { throw new Error('indisponível no app'); },
    micInfo: () => null,
    reframeState: () => (rf.on ? { mode: !landscape() ? 'portrait' : rf.follow ? 'follow' : 'center', engine: 'ML Kit (nativo)', center: rf.center, faces: rf.faces, updates: rf.updates } : null),
    /** Centro da janela 9:16 no PREVIEW (0..1; a frontal é espelhada), ou null sem máscara. */
    maskCenter: () => (open && rf.on && landscape() ? (getSettings().facing === 'environment' ? rf.center : 1 - rf.center) : null),
    pauseReframe: () => {},
    isVertical: () => false,
    videoSize,
    recStart: () => NativeCam.startRecording(),
    recStop: () => NativeCam.stopRecording(),
    makeVertical: (path, onProgress) => {
      const sub = Promise.resolve(NativeCam.addListener('verticalProgress', ({ p }) => onProgress(p / 100)));
      return NativeCam.makeVertical({ path }).finally(() => sub.then((h) => h?.remove()));
    },
    cancelVertical: () => NativeCam.cancelVertical().catch(() => {}),
  };
}
