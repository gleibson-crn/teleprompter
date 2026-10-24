// Gera os PNGs do ícone do app (sem dependências): `node tools/make-icons.mjs`
// Desenho: fundo escuro, linhas de texto claras e a faixa de leitura em âmbar.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [11, 13, 18];
const PANEL = [30, 36, 48];
const LINE = [232, 235, 241];
const ACCENT = [245, 179, 1];

// Coordenadas normalizadas (0–1) dentro da área útil do ícone.
const LINES = [
  { y: 0.28, x0: 0.22, x1: 0.70, c: LINE },
  { y: 0.40, x0: 0.22, x1: 0.78, c: LINE },
  { y: 0.52, x0: 0.22, x1: 0.62, c: ACCENT },
  { y: 0.64, x0: 0.22, x1: 0.74, c: LINE },
  { y: 0.76, x0: 0.22, x1: 0.52, c: LINE },
];

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function draw(size, { maskable }) {
  const px = Buffer.alloc(size * size * 3);
  const pad = maskable ? 0.18 : 0.04; // maskable: conteúdo na zona segura (80%)
  const s = 1 - pad * 2;
  const thick = 0.075 * s * size;
  const bandH = 0.11 * s * size;
  const radius = 0.2 * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = BG;
      if (!maskable) {
        // cantos arredondados do painel (fundo transparente não é usado; borda escura)
        const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
        const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
        c = mix(BG, PANEL, clamp01(radius - Math.hypot(dx, dy)) * 0.6);
      }
      const ny = (y / size - pad) / s;
      const nx = (x / size - pad) / s;
      // faixa de leitura
      if (Math.abs(ny - 0.52) * s * size < bandH / 2) c = mix(c, ACCENT, 0.18);
      for (const l of LINES) {
        // cápsula: distância ao segmento horizontal
        const cx = Math.min(Math.max(nx, l.x0), l.x1);
        const d = Math.hypot((nx - cx) * s * size, (ny - l.y) * s * size);
        const cov = clamp01(thick / 2 - d + 0.5);
        if (cov > 0) c = mix(c, l.c, cov);
      }
      px.set(c, (y * size + x) * 3);
    }
  }
  return png(size, px);
}

function png(size, rgb) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 bits, RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const out = new URL('../icons/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('icon-192.png', out), draw(192, { maskable: false }));
writeFileSync(new URL('icon-512.png', out), draw(512, { maskable: false }));
writeFileSync(new URL('icon-maskable-512.png', out), draw(512, { maskable: true }));
writeFileSync(new URL('apple-touch-icon.png', out), draw(180, { maskable: true }));
console.log('Ícones gerados em icons/');
