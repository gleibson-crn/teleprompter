// Copia o site (o mesmo do GitHub Pages, sem build) para www/, que vira o app do APK.
// Fica de fora: vendor/ (detector de rosto ~12 MB — o Vertical inteligente ainda não existe
// no APK), android/, node_modules/, sw.js (o APK não usa service worker) e ferramentas.
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const item of ['index.html', 'manifest.webmanifest', 'css', 'js', 'icons']) {
  cpSync(join(root, item), join(out, item), { recursive: true });
}
console.log('www/ pronto');
