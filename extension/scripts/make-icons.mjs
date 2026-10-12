// Render the PNG icons from public/icons/icon.svg with Playwright's Chromium,
// and the Windows installer icon (installer/windows/video-down.ico, PNG-compressed entries).
// Usage: node scripts/make-icons.mjs

import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(resolve(root, "public/icons/icon.svg"), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage();

async function render(size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  return page.locator("svg").screenshot({ omitBackground: true });
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(resolve(root, `public/icons/icon-${size}.png`), await render(size));
  console.log(`icon-${size}.png`);
}

// ICO container with PNG payloads (supported since Windows Vista).
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = [];
for (const size of sizes) images.push(await render(size));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);
const entries = [];
let offset = 6 + 16 * sizes.length;
sizes.forEach((size, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0);
  e.writeUInt8(size >= 256 ? 0 : size, 1);
  e.writeUInt8(0, 2); // palette
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  entries.push(e);
});
writeFileSync(resolve(root, "../installer/windows/video-down.ico"), Buffer.concat([header, ...entries, ...images]));
console.log("video-down.ico");
await browser.close();
