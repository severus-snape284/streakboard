// Render tools/icon.svg to the PNG icons with the preinstalled Chromium.
// Usage: node tools/render_icons.mjs   (then icons/ is updated)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(ROOT, 'tools/icon.svg'), 'utf8');

// mode: 'square' (full bleed; iOS rounds it), 'rounded' (transparent corners), 'maskable' (mark shrunk into the safe zone)
const targets = [
  ['icons/apple-touch-icon.png', 180, 'square'],
  ['icons/icon-192.png', 192, 'rounded'],
  ['icons/icon-512.png', 512, 'rounded'],
  ['icons/icon-maskable-512.png', 512, 'maskable'],
  ['icons/favicon-32.png', 32, 'rounded'],
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [out, size, mode] of targets) {
  let s = svg;
  if (mode === 'maskable') s = s.replace('<g id="mark">', '<g id="mark" transform="translate(512 540) scale(0.78) translate(-512 -540)">');
  const radius = mode === 'rounded' ? '22.5%' : '0';
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">
    <div style="width:${size}px;height:${size}px;border-radius:${radius};overflow:hidden">${s.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`);
  await page.screenshot({ path: path.join(ROOT, out), omitBackground: mode === 'rounded' });
  console.log('wrote', out);
}
await browser.close();
