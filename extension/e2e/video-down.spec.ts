/**
 * End-to-end tests: the real extension (dist-e2e) loaded in Playwright's Chromium,
 * against local pages that reproduce each case of the routing table in README.md.
 *
 * Run with: pnpm run test:e2e   (builds dist-e2e and the media fixtures first)
 */

import { test as base, expect, chromium, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { startServer } from "./server.mjs";

const execFileAsync = promisify(execFile);
const EXTENSION = resolve(dirname(fileURLToPath(import.meta.url)), "../dist-e2e");

type Fixtures = { page: Page };
type WorkerFixtures = { extContext: BrowserContext; baseUrl: string; downloads: string };

const test = base.extend<Fixtures, WorkerFixtures>({
  baseUrl: [
    async ({}, use) => {
      const server: Server = await startServer(0);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      await use(`http://127.0.0.1:${port}`);
      server.close();
    },
    { scope: "worker" },
  ],
  downloads: [
    async ({}, use) => {
      const dir = mkdtempSync(join(tmpdir(), "video-down-e2e-dl-"));
      await use(dir);
      rmSync(dir, { recursive: true, force: true });
    },
    { scope: "worker" },
  ],
  extContext: [
    async ({ downloads }, use) => {
      const profile = mkdtempSync(join(tmpdir(), "video-down-e2e-profile-"));
      // On macOS and Linux, Chromium looks for native messaging hosts inside its user data
      // directory. A real Chrome profile is where the installer registers it; this temporary
      // profile is not, so copy the manifest in. (Windows uses the registry, so nothing to do.)
      const hostFile = "dev.marianogutierrez.videodown.json";
      const installed = [
        join(homedir(), "Library/Application Support/Chromium/NativeMessagingHosts", hostFile),
        join(homedir(), ".config/chromium/NativeMessagingHosts", hostFile),
      ].find((p) => existsSync(p));
      if (installed) {
        mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
        copyFileSync(installed, join(profile, "NativeMessagingHosts", hostFile));
      }
      const context = await chromium.launchPersistentContext(profile, {
        channel: "chromium",
        headless: true,
        locale: "en-US",
        acceptDownloads: true,
        downloadsPath: downloads,
        args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--lang=en-US"],
      });
      // Wait for the service worker so the extension is ready before the first page loads.
      if (context.serviceWorkers().length === 0) await context.waitForEvent("serviceworker");
      // On a brand-new install Chrome only learns the worker's webRequest listeners once its
      // script has run. (An installed extension's worker is woken for each request instead.)
      await new Promise((r) => setTimeout(r, 1000));
      // Close the welcome tab opened on install.
      for (const p of context.pages()) if (p.url().includes("options.html")) await p.close();
      await use(context);
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    },
    { scope: "worker" },
  ],
  page: async ({ extContext }, use) => {
    const page = await extContext.newPage();
    await use(page);
    await page.close();
  },
});

const trigger = (page: Page, name = /Download this video|DRM-protected video/) =>
  page.locator("video-down-overlay").getByRole("button", { name });
const menu = (page: Page) => page.locator("video-down-overlay").getByRole("dialog");
/** The one icon on each video ("play"); hovering it unfolds the download and record buttons. */
const hub = (page: Page) => page.locator("video-down-overlay").getByRole("button", { name: /^video-down: / });
const recButton = (page: Page) => page.locator("video-down-overlay").getByRole("button", { name: /Record this video|Recording this video/ });

/**
 * Move the pointer onto the icon, as a person would. (Playwright's hover() insists on the target
 * staying visible, but the icon unfolds, and so disappears, the moment the pointer reaches it.)
 */
async function pointAt(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("the icon is not on screen");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Point at the icon until `revealed` shows. The pointer is placed once and stays still; if the page
 * moves a little right after (a web font loading in an iframe), it is no longer over the icon, so
 * point again, as a person would move the mouse.
 */
async function unfold(page: Page, icon: Locator, revealed: Locator) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await revealed.isVisible()) return;
    await pointAt(page, icon);
    try {
      await revealed.waitFor({ state: "visible", timeout: 2000 });
      return;
    } catch {
      // moved away: try again
    }
  }
  await expect(revealed).toBeVisible();
}

async function openDownload(page: Page) {
  await unfold(page, hub(page).first(), trigger(page).first());
  await trigger(page).first().click();
}

async function openRecord(page: Page) {
  await unfold(page, hub(page).first(), recButton(page).first());
  await recButton(page).first().click();
}

function newestFile(dir: string, since: number): string | null {
  const files = readdirSync(dir)
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile() && statSync(f).mtimeMs >= since && !f.endsWith(".crdownload"));
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

function probe(file: string): { width?: number; height?: number; video?: string; audio?: string } {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], { encoding: "utf8" });
    const streams = JSON.parse(out).streams as Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>;
    const v = streams.find((s) => s.codec_type === "video");
    const a = streams.find((s) => s.codec_type === "audio");
    return { width: v?.width, height: v?.height, video: v?.codec_name, audio: a?.codec_name };
  } catch {
    return {};
  }
}

async function downloadAndCheck(
  target: Page | Locator,
  downloads: string,
  option: RegExp,
  expected: { height: number },
) {
  const since = Date.now() - 1000;
  const m = "goto" in target ? menu(target) : target;
  await m.getByRole("button", { name: option }).click();
  await expect(m.getByText("Download finished")).toBeVisible({ timeout: 90_000 });
  await expect.poll(() => newestFile(downloads, since), { timeout: 15_000 }).not.toBeNull();
  const file = newestFile(downloads, since)!;
  const info = probe(file);
  expect(info, `ffprobe could not read ${file}`).toMatchObject({ height: expected.height, video: "h264", audio: "aac" });
}

// ---------------------------------------------------------------- cases

test("1 · direct file: one icon in the top-left corner that unfolds (download only: not live)", async ({ page, baseUrl, downloads }) => {
  await page.goto(`${baseUrl}/direct.html`);
  // A single "play" icon until the pointer reaches it.
  await expect(hub(page)).toBeVisible();
  await expect(trigger(page)).toBeHidden();
  await expect(recButton(page)).toBeHidden();
  const v = await page.locator("video").boundingBox();
  const h = await hub(page).boundingBox();
  expect(Math.abs(h!.x - (v!.x + 8))).toBeLessThan(3);
  expect(Math.abs(h!.y - (v!.y + 8))).toBeLessThan(3);

  // Hover: it unfolds; download appears where the icon was. Not a live broadcast: no record button.
  await pointAt(page, hub(page));
  await expect(trigger(page)).toBeVisible();
  await expect(recButton(page)).toBeHidden();
  await page.waitForTimeout(300); // the unfolding animation
  const d = await trigger(page).boundingBox();
  expect(Math.abs(d!.x - h!.x)).toBeLessThan(5);

  // A still pointer keeps it unfolded (it used to flicker when the icon was swapped under it).
  await page.waitForTimeout(1200);
  await expect(trigger(page)).toBeVisible();
  await expect(hub(page)).toBeHidden();

  // The pointer leaves: it folds back into one icon.
  await page.mouse.move(v!.x + v!.width - 10, v!.y + v!.height - 10);
  await expect(hub(page)).toBeVisible({ timeout: 3000 });
  await expect(trigger(page)).toBeHidden();

  await openDownload(page);
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible();
  await expect(menu(page).getByRole("button", { name: /360p/ })).toBeVisible();
  await downloadAndCheck(page, downloads, /360p/, { height: 360 });
});

test("2 · HLS master: one entry per variant, merged with ffmpeg.wasm", async ({ page, baseUrl, downloads }) => {
  await page.goto(`${baseUrl}/hls.html`);
  await openDownload(page);
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
  await expect(menu(page).getByRole("button", { name: /360p/ })).toBeVisible();
  await downloadAndCheck(page, downloads, /720p/, { height: 720 });
  // The progress sits above the choices, so a long list never hides it.
  const progressFirst = await menu(page).evaluate((m) => {
    const jobs = m.querySelector(".vd-jobs");
    const list = m.querySelector(".vd-list");
    return !!jobs && !!list && !!(jobs.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(progressFirst).toBe(true);
});

test("2a · HLS master whose audio rendition has no URI (Unified Streaming): every quality listed", async ({ page, baseUrl, downloads }) => {
  await page.goto(`${baseUrl}/hls-muxed-audio.html`);
  await openDownload(page);
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
  await expect(menu(page).getByRole("button", { name: /360p/ })).toBeVisible();
  await downloadAndCheck(page, downloads, /360p/, { height: 360 });
});

test("2b · HLS served without .m3u8 extension is recognised by Content-Type", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/hls-noext.html`);
  await openDownload(page);
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
});

test("2c · HLS with AES-128 (not DRM) is decrypted and saved", async ({ page, baseUrl, downloads }) => {
  await page.goto(`${baseUrl}/hls-aes.html`);
  await openDownload(page);
  await expect(menu(page).getByRole("button", { name: /Original file/ })).toBeVisible({ timeout: 15_000 });
  await downloadAndCheck(page, downloads, /Original file/, { height: 360 });
});

test("2d · HLS served as text/plain without extension is recognised by its content", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/odd-type.html`);
  await openDownload(page);
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
});

test("2e · player in a cross-origin iframe whose CDN demands the player's Referer", async ({ page, baseUrl, downloads }) => {
  // Top page on localhost, player iframe on 127.0.0.1: two origins, as with any site embedding a
  // third-party player (course platforms, video hosts…) whose CDN checks the Referer.
  await page.goto(`http://localhost:${new URL(baseUrl).port}/embed-host.html`);
  const overlay = page.frameLocator("#player").locator("video-down-overlay");
  await unfold(page, overlay.getByRole("button", { name: /^video-down: / }), overlay.getByRole("button", { name: /Download this video/ }));
  await overlay.getByRole("button", { name: /Download this video/ }).click();
  const m = overlay.getByRole("dialog");
  await expect(m.getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
  await downloadAndCheck(m, downloads, /360p/, { height: 360 });
});

test("2n · a player in an iframe the page covers with a transparent layer: its icon still unfolds and opens", async ({ page, baseUrl }) => {
  // Many sites lay an invisible layer over an embedded player to catch the first click for an ad.
  // The pointer never reached the iframe: the icon could be seen, not hovered nor clicked.
  await page.goto(`http://localhost:${new URL(baseUrl).port}/covered-embed.html`);
  const overlay = page.frameLocator("#player").locator("video-down-overlay");
  const icon = overlay.getByRole("button", { name: /^video-down: / });
  await expect(icon).toBeVisible({ timeout: 10_000 });
  // Onto the icon and a little further, as a person moves the mouse: the first move reaches the
  // page (its layer is lifted then), the next ones the player's frame.
  const box = (await icon.boundingBox())!;
  for (const d of [0, 2, 4]) await page.mouse.move(box.x + 12 + d, box.y + 12 + d);
  await expect(overlay.getByRole("button", { name: /Download this video/ })).toBeVisible({ timeout: 5000 });
  await overlay.getByRole("button", { name: /Download this video/ }).click();
  await expect(overlay.getByRole("dialog").getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as { coverClicks: number }).coverClicks)).toBe(0);
  // Away from the icon and with the menu closed, the layer is the page's again.
  await page.keyboard.press("Escape");
  await page.mouse.move(5, 5);
  await expect.poll(() => page.locator("#cover").evaluate((el) => getComputedStyle(el).pointerEvents), { timeout: 5000 }).toBe("auto");
  const cover = (await page.locator("#cover").boundingBox())!;
  await page.mouse.click(cover.x + cover.width / 2, cover.y + cover.height - 20);
  expect(await page.evaluate(() => (window as unknown as { coverClicks: number }).coverClicks)).toBe(1);
});

test("2o · HLS whose segments redirect to another server that checks the Referer: downloaded", async ({ page, baseUrl, downloads }) => {
  // The page's headers did not follow a redirect to a host no rule covered: every segment was refused.
  await page.goto(`${baseUrl}/hls-redirect.html`);
  await openDownload(page);
  await expect(menu(page).getByRole("button", { name: /360p/ })).toBeVisible({ timeout: 15_000 });
  await downloadAndCheck(page, downloads, /360p/, { height: 360 });
  // By the browser engine itself, not handed over to yt-dlp after failing.
  await expect(menu(page).locator(".vd-job .vd-option-meta", { hasText: "yt-dlp" })).toHaveCount(0);
});

test("2f · same, with variants and segments on another host that also checks the Referer", async ({ page, baseUrl, downloads }) => {
  await page.goto(`http://localhost:${new URL(baseUrl).port}/embed-host.html?player=player-cross.html`);
  const overlay = page.frameLocator("#player").locator("video-down-overlay");
  await unfold(page, overlay.getByRole("button", { name: /^video-down: / }), overlay.getByRole("button", { name: /Download this video/ }));
  await overlay.getByRole("button", { name: /Download this video/ }).click();
  const m = overlay.getByRole("dialog");
  await expect(m.getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
  await downloadAndCheck(m, downloads, /720p/, { height: 720 });
});

test("2g · single-use playlist link: the player's own copy lists the qualities and the download works", async ({ page, baseUrl, downloads }) => {
  // The extension cannot read this master again (403), but the page's player already did.
  await page.goto(`${baseUrl}/once.html`);
  await openDownload(page);
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 20_000 });
  await expect(menu(page).getByRole("button", { name: /360p/ })).toBeVisible();
  await downloadAndCheck(page, downloads, /360p/, { height: 360 });
});

test("2h · playlist in a platform's own encrypted format: explained, not broken", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/opaque.html`);
  await openDownload(page);
  await expect(menu(page).getByText(/not standard HLS or DASH/)).toBeVisible({ timeout: 20_000 });
  await expect(menu(page).getByRole("button", { name: /native component/ })).toHaveCount(0);
});

for (const [name, what] of [
  ["hls-aes-noiv", "AES-128 without IV attribute (IV = media sequence number)"],
  ["hls-aes-zeroiv", "AES-128 with an IV whose words start with zero bytes"],
  ["hls-byterange", "whole stream in one file addressed with EXT-X-BYTERANGE"],
] as const) {
  test(`2i · ${what}`, async ({ page, baseUrl, downloads }) => {
    await page.goto(`${baseUrl}/${name}.html`);
    await openDownload(page);
    await expect(menu(page).getByRole("button", { name: /Original file/ })).toBeVisible({ timeout: 15_000 });
    await downloadAndCheck(page, downloads, /Original file/, { height: 360 });
  });
}

test("2j · only one variant is requested: the master next to it is found and its qualities offered", async ({ page, baseUrl, downloads, extContext }) => {
  // Unified Origin names and a token on every playlist: the variants listed by the found master
  // must inherit the token of the playlist the player used.
  await page.goto(`${baseUrl}/hls-variant-only.html`);
  await openDownload(page);
  // First the one quality the page asked for; then, without reopening, the master's qualities.
  await expect(menu(page).getByRole("button", { name: /Original file/ })).toBeVisible({ timeout: 15_000 });
  await expect(menu(page).getByRole("button", { name: /360p/ })).toBeVisible({ timeout: 20_000 });
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible();
  await downloadAndCheck(page, downloads, /360p/, { height: 360 });

  // The diagnostic report tells what happened, without tokens.
  const opened = extContext.waitForEvent("page");
  await menu(page).getByRole("button", { name: "Diagnostic report" }).click();
  const report = await opened;
  await expect(report.locator("#diag-text")).toContainText("master-found", { timeout: 15_000 });
  await expect(report.locator("#diag-text")).toContainText("/media/uni/clip.m3u8");
  await expect(report.locator("#diag-text")).not.toContainText("token=abc");
  await report.close();
});

test("2k · the page rewrites its own address while the same video plays: qualities are kept", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/hls-rewrite-url.html`);
  await expect(page).toHaveTitle("rewritten", { timeout: 10_000 });
  await page.waitForTimeout(1500); // longer than the extension's address polling
  await openDownload(page);
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
  await expect(menu(page).getByRole("button", { name: /360p/ })).toBeVisible();
});

test("2l · single-page app loads another video: the previous one's qualities are gone", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/hls-spa.html`);
  await expect(page).toHaveTitle("second", { timeout: 15_000 });
  await openDownload(page);
  await expect(menu(page).getByRole("button", { name: /Original file/ })).toBeVisible({ timeout: 15_000 });
  await expect(menu(page).getByRole("button", { name: /720p/ })).toHaveCount(0);
});

test("2m · playlists fetched by the page's service worker are recognised", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/swtest/sw.html`);
  await expect(page).toHaveTitle("controlled", { timeout: 15_000 });
  await openDownload(page);
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
  await expect(menu(page).getByRole("button", { name: /360p/ })).toBeVisible();
});

test("11b · a live broadcast whose audio never starts: the capture records the picture only", async ({ page, baseUrl, downloads, extContext }) => {
  await page.goto(`${baseUrl}/capture-silent.html`);
  await expect(page).toHaveTitle("playing", { timeout: 10_000 });
  await openRecord(page);
  const balanced = menu(page).getByRole("button", { name: /Balanced/ });
  await expect(balanced).toBeVisible({ timeout: 10_000 });
  const opened = extContext.waitForEvent("page");
  await balanced.click();
  const recorder = await opened;
  const file = await recordAndSave(recorder, downloads, 3);
  await expect(recorder.locator("#notice")).toContainText("only the picture");
  const info = probe(file);
  expect(info.height).toBe(360);
  expect(info.audio).toBeUndefined();
  await recorder.close();
});

test("12 · a preview inside a link: the full video of that page, never the teaser", async ({ page, baseUrl, downloads }) => {
  await page.goto(`${baseUrl}/preview.html`);
  await pointAt(page, hub(page));
  await expect(trigger(page)).toBeVisible();
  await expect(recButton(page)).toBeHidden();
  await trigger(page).click();
  if (process.env.VD_E2E_NATIVE === "1") {
    // yt-dlp reads the linked page: its title and its 720p video, not the 360p teaser.
    await expect(menu(page).getByText("Full video")).toBeVisible({ timeout: 60_000 });
    await menu(page).locator(".vd-list button").first().click();
    await expect(menu(page).getByText("Download finished")).toBeVisible({ timeout: 120_000 });
    const saved = (await menu(page).locator(".vd-path").first().textContent())?.trim() ?? "";
    expect(probe(saved)).toMatchObject({ height: 720 });
    rmSync(saved, { force: true });
  } else {
    await expect(menu(page).getByText(/This is a preview|native component is needed|full video/i).first()).toBeVisible({ timeout: 30_000 });
  }
  await expect(menu(page).getByRole("button", { name: /Original file|360p/ })).toHaveCount(0);
});

test("12b · one preview player shared by thumbnails: the menu stays put, open and on its video", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/shared-preview.html`);
  const a = (await page.locator("#a").boundingBox())!;
  const b = (await page.locator("#b").boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await openDownload(page);
  if (process.env.VD_E2E_NATIVE === "1") {
    await expect(menu(page)).toContainText("Analysing the available download options, please wait...");
  }
  const before = (await menu(page).boundingBox())!;

  // The site moves its player to the other thumbnail, then takes it away.
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(800);
  await page.evaluate(() => (window as unknown as { removePreview(): void }).removePreview());
  await page.waitForTimeout(800);

  await expect(menu(page)).toBeVisible();
  const after = (await menu(page).boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  if (process.env.VD_E2E_NATIVE === "1") {
    // Still the video of the first thumbnail.
    await expect(menu(page).getByText("Page A")).toBeVisible({ timeout: 60_000 });
    await expect(menu(page).getByText("Page B")).toHaveCount(0);
  }
});

test("12c · a video covered by another layer gets no icon", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/covered.html`);
  await expect(hub(page)).toHaveCount(1, { timeout: 10_000 });
  const v = (await page.locator("#seen").boundingBox())!;
  const h = (await hub(page).boundingBox())!;
  expect(Math.abs(h.y - (v.y + 8))).toBeLessThan(5);
});

test("12d · opening a video over the grid: one icon, on the opened video (the old preview stays hidden under it)", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/shared-preview.html`);
  const a = (await page.locator("#a").boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await expect(hub(page)).toHaveCount(1, { timeout: 10_000 });
  await page.mouse.click(a.x + a.width / 2, a.y + a.height / 2);
  await expect(page.locator("#main")).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(hub(page)).toHaveCount(1);
  const m = (await page.locator("#main").boundingBox())!;
  const h = (await hub(page).boundingBox())!;
  expect(Math.abs(h.x - (m.x + 8))).toBeLessThan(5);
  expect(Math.abs(h.y - (m.y + 8))).toBeLessThan(5);
});

test("12e · a preview laid over its thumbnail (not inside the link): the full video of the linked page", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/preview-over.html`);
  await openDownload(page);
  await expect(recButton(page)).toBeHidden();
  if (process.env.VD_E2E_NATIVE === "1") {
    await expect(menu(page).getByText("Page A")).toBeVisible({ timeout: 60_000 });
  } else {
    await expect(menu(page).getByText(/This is a preview|native component is needed|Page A/i).first()).toBeVisible({ timeout: 30_000 });
  }
  await expect(menu(page).getByRole("button", { name: /Original file|360p/ })).toHaveCount(0);
});

test("12f · a preview taken away when the pointer reaches the icon: the icon stays, still and usable", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/hover-preview.html`);
  const thumb = (await page.locator("#thumb").boundingBox())!;
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await expect(hub(page)).toHaveCount(1, { timeout: 10_000 });
  await unfold(page, hub(page), trigger(page));
  await page.waitForTimeout(300); // the unfolding animation
  // Moving onto the icon left the thumbnail, so the page took its preview away. The icon used to
  // vanish with it; the thumbnail was then under the pointer again, the preview came back, and so
  // on, many times a second.
  await expect(page.locator("#thumb video")).toHaveCount(0);
  const first = (await trigger(page).boundingBox())!;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(75);
    expect(await trigger(page).isVisible()).toBe(true);
    const now = (await trigger(page).boundingBox())!;
    expect(Math.abs(now.x - first.x) + Math.abs(now.y - first.y)).toBeLessThan(1);
  }
  expect(await page.evaluate(() => (window as unknown as { enters: number }).enters)).toBeLessThanOrEqual(2);
  await trigger(page).click();
  await expect(recButton(page)).toBeHidden();
  if (process.env.VD_E2E_NATIVE === "1") {
    await expect(menu(page).getByText("Page A")).toBeVisible({ timeout: 60_000 });
  } else {
    await expect(menu(page).getByText(/This is a preview|native component is needed|Page A/i).first()).toBeVisible({ timeout: 30_000 });
  }
  await expect(menu(page).getByRole("button", { name: /Original file|360p/ })).toHaveCount(0);
});

test("12g · resting the pointer on the icon starts looking for the choices: the menu opens with them", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/slow-size.html`);
  await expect(hub(page)).toHaveCount(1, { timeout: 10_000 });
  const heads = async () => Number(await (await page.request.get(`${baseUrl}/slowhead-count`)).text());
  const before = await heads();
  await unfold(page, hub(page), trigger(page));
  // The file's size is asked while the pointer rests on the icon, before any click.
  await expect.poll(heads, { timeout: 5000 }).toBe(before + 1);
  await page.waitForTimeout(3500);
  await trigger(page).click();
  // Already answered: no second question and no 3 s wait.
  await expect(menu(page).getByRole("button", { name: /360p.*(KB|MB)/ })).toBeVisible({ timeout: 1500 });
  expect(await heads()).toBe(before + 1);
});

test("12h · a menu closed without downloading: the icon goes on with the shared preview player", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/shared-preview.html`);
  const a = (await page.locator("#a").boundingBox())!;
  const b = (await page.locator("#b").boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await openDownload(page);
  await expect(menu(page)).toBeVisible();
  // Closed with its × (or Escape): the focus goes back to the icon's download button.
  await menu(page).getByRole("button", { name: "Close" }).click();
  await expect(menu(page)).toBeHidden();
  // The site moves its one preview player to the other thumbnail: the icon must go with it, not
  // stay held where the menu was.
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  const icon = page.locator("video-down-overlay").getByRole("button", { name: /^video-down: |Download this video/ });
  await expect
    .poll(async () => {
      for (const button of await icon.all()) {
        if (await button.isVisible()) return Math.round(((await button.boundingBox())?.x ?? 0) - b.x);
      }
      return null;
    }, { timeout: 5000 })
    .toBe(8);
  await page.keyboard.press("Escape");
  for (const [x, y] of [[a.x + a.width / 2, a.y + a.height / 2], [b.x + b.width / 2, b.y + b.height / 2]]) {
    await page.mouse.move(x!, y!);
    await page.waitForTimeout(500);
    const visible = [];
    for (const button of await icon.all()) if (await button.isVisible()) visible.push(await button.boundingBox());
    expect(visible).toHaveLength(1);
  }
});

// ---------------------------------------------------------------- recording

/** The recorder page: wait for something recorded, stop, save, and check the file with ffprobe. */
async function recordAndSave(recorder: Page, downloads: string, seconds: number) {
  await expect(recorder.locator("#state")).toHaveText("Recording", { timeout: 20_000 });
  await expect
    .poll(async () => {
      const [m, s] = ((await recorder.locator("#duration").textContent()) ?? "0:00").split(":").map(Number);
      return (m ?? 0) * 60 + (s ?? 0);
    }, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(seconds);
  // The time-shift player plays what has been recorded so far.
  await expect.poll(() => recorder.locator("#player").evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await recorder.locator("#stop").click();
  await expect(recorder.locator("#state")).not.toHaveText("Recording", { timeout: 20_000 });
  // It says where it records until saved, and proposes a name that can be changed.
  await expect(recorder.getByText(/storage inside Chrome/)).toBeVisible();
  const name = recorder.locator("#name");
  await expect(name).not.toHaveValue("");
  await name.fill("My recording ñ");
  const since = Date.now() - 1000;
  await recorder.locator("#save").click();
  await expect(recorder.locator("#save-status")).toContainText("Saved to", { timeout: 120_000 });
  await expect(recorder.locator("#show")).toBeVisible();
  await expect.poll(() => newestFile(downloads, since), { timeout: 15_000 }).not.toBeNull();
  return newestFile(downloads, since)!;
}

function durationOf(file: string): number {
  try {
    return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());
  } catch {
    return 0;
  }
}

test("10 · live HLS: the icon unfolds into download and record; exact copy, time-shift, MP4", async ({ page, baseUrl, downloads, extContext }) => {
  await page.goto(`${baseUrl}/live.html`);
  // A live broadcast: both buttons, record next to download.
  await pointAt(page, hub(page));
  await expect(recButton(page)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300); // the unfolding animation
  const d = await trigger(page).boundingBox();
  const r = await recButton(page).boundingBox();
  expect(r!.x).toBeGreaterThan(d!.x + d!.width);
  await openRecord(page);
  const copy = menu(page).getByRole("button", { name: /360p/ });
  await expect(copy).toBeVisible({ timeout: 20_000 });
  const opened = extContext.waitForEvent("page");
  await copy.click();
  const recorder = await opened;
  await expect(recButton(page)).toHaveAccessibleName("Recording this video");
  // The first reload already brings 6 s (the live edge): 10 s proves later segments are followed.
  const file = await recordAndSave(recorder, downloads, 10);
  expect(probe(file)).toMatchObject({ height: 360, video: "h264", audio: "aac" });
  expect(durationOf(file)).toBeGreaterThanOrEqual(9);
  await recorder.close();
});

test("10b · a live broadcast whose playlist only its player may read: recognised from the player's copy", async ({ page, baseUrl }) => {
  // The extension's own reading of the quality gets a 403, which used to count as "not live":
  // no record button for a live broadcast. The player's copy says it is live.
  await page.goto(`${baseUrl}/live-guarded.html`);
  await expect(page).toHaveTitle(/reloads: [3-9]/, { timeout: 15_000 });
  await pointAt(page, hub(page));
  await expect(recButton(page)).toBeVisible({ timeout: 15_000 });
});

test("10e · exact copy of a live stream whose segments redirect to another server that checks the Referer", async ({ page, baseUrl, downloads, extContext }) => {
  await page.goto(`${baseUrl}/live-redirect.html`);
  await openRecord(page);
  const copy = menu(page).getByRole("button", { name: /360p/ });
  await expect(copy).toBeVisible({ timeout: 20_000 });
  const opened = extContext.waitForEvent("page");
  await copy.click();
  const recorder = await opened;
  const file = await recordAndSave(recorder, downloads, 6);
  await expect(recorder.locator("#notice")).toBeHidden();
  expect(probe(file)).toMatchObject({ height: 360, video: "h264" });
  await recorder.close();
});

test("10f · a live player embedded in an iframe: the recording takes the page's title, not the player's", async ({ page, baseUrl, extContext }) => {
  await page.goto(`http://localhost:${new URL(baseUrl).port}/embed-host.html?player=live.html`);
  const overlay = page.frameLocator("#player").locator("video-down-overlay");
  const rec = overlay.getByRole("button", { name: /Record this video/ });
  await unfold(page, overlay.getByRole("button", { name: /^video-down: / }), rec);
  await rec.click();
  const copy = overlay.getByRole("dialog").getByRole("button", { name: /360p/ });
  await expect(copy).toBeVisible({ timeout: 20_000 });
  const opened = extContext.waitForEvent("page");
  await copy.click();
  const recorder = await opened;
  await expect(recorder.locator("#title")).toHaveText("Course page with embedded player", { timeout: 15_000 });
  await expect(recorder.locator("#name")).toHaveValue(/^Course page with embedded player/);
  await recorder.locator("#stop").click();
  recorder.on("dialog", (d) => void d.accept());
  await recorder.locator("#discard").click();
  await recorder.close().catch(() => undefined);
});

test("10d · a live playlist served as text/html without extension: recognised, and copied exactly", async ({ page, baseUrl }) => {
  // Some live CDNs hide their playlist this way; the extension did not read text/html bodies.
  await page.goto(`${baseUrl}/live-html.html`);
  await expect(page).toHaveTitle(/reloads: [3-9]/, { timeout: 15_000 });
  await openRecord(page);
  // A lone media playlist (no master): its only quality, copied as it comes.
  await expect(menu(page).getByRole("button", { name: /Original file/ })).toBeVisible({ timeout: 20_000 });
});

test("10c · a live broadcast told only by its growing duration (a finite one, as hls.js gives it)", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/live-growing.html`);
  await expect(page).toHaveTitle(/grown: [3-9]/, { timeout: 15_000 });
  await pointAt(page, hub(page));
  await expect(recButton(page)).toBeVisible({ timeout: 10_000 });
});

for (const [profile, codecs] of [
  ["Best quality", ["h264"]],
  ["Balanced", ["vp9", "h264"]],
  ["Small file", ["av1", "vp9"]],
  ["Less CPU", ["h264"]],
] as const) {
  test(`11 · any player: capture with the "${profile}" profile, time-shift player, saved as MP4`, async ({ page, baseUrl, downloads, extContext }) => {
    await page.goto(`${baseUrl}/capture.html`);
    await expect(page).toHaveTitle("playing", { timeout: 10_000 });
    await openRecord(page);
    await expect(menu(page).getByText("Capture the player")).toBeVisible({ timeout: 10_000 });
    const option = menu(page).getByRole("button", { name: new RegExp(profile) });
    test.skip((await option.count()) === 0, `this browser cannot record the "${profile}" profile`);
    const opened = extContext.waitForEvent("page");
    await option.click();
    const recorder = await opened;
    recorder.on("console", (m) => m.type() === "warning" && console.log(`[recorder] ${m.text()}`));
    const file = await recordAndSave(recorder, downloads, 3);
    const info = probe(file);
    expect(codecs as readonly string[]).toContain(info.video);
    expect(info.height).toBe(360);
    expect(durationOf(file)).toBeGreaterThanOrEqual(2.5);
    await recorder.close();
  });
}

test("3 · DASH: video representations listed, audio merged", async ({ page, baseUrl, downloads }) => {
  await page.goto(`${baseUrl}/dash.html`);
  await openDownload(page);
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
  await expect(menu(page).getByRole("button", { name: /360p/ })).toBeVisible();
  await downloadAndCheck(page, downloads, /360p/, { height: 360 });
});

test("8a · DRM declared in the DASH manifest: warning, no resolutions", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/drm-dash.html`);
  await openDownload(page);
  await expect(menu(page).getByText(/DRM-protected video/)).toBeVisible({ timeout: 15_000 });
  await expect(menu(page).getByText(/Widevine/)).toBeVisible();
  await expect(menu(page).getByRole("button", { name: /\d{3,4}p/ })).toHaveCount(0);
});

test("8b · DRM through EME on the element: lock icon and warning", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/drm-eme.html`);
  await expect(page).toHaveTitle("EME ready");
  const lock = trigger(page, /DRM-protected video/);
  await pointAt(page, hub(page));
  await expect(lock).toBeVisible();
  await lock.click();
  await expect(menu(page).getByRole("alert")).toContainText(/DRM-protected video/);
  await expect(menu(page).getByRole("button", { name: /\d{3,4}p|Original/ })).toHaveCount(0);
});

test("5 · blob video with no manifest: no browser download is offered", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/unknown.html`);
  await openDownload(page);
  // Either the native component is missing (explanation) or it is installed and yt-dlp
  // cannot read a local test page (error). In both cases no browser resolution is offered.
  await expect(
    menu(page).getByText(/native component is needed|was not found|could not read|ERROR|failed/i).first(),
  ).toBeVisible({ timeout: 30_000 });
});

test("the page's own failures stay its own: none is reported at the extension's scripts", async ({ page, baseUrl }) => {
  // Chrome blames an uncaught error on the script at the top of its stack. The extension's
  // wrappers of fetch, XHR, history and EME used to be there, so failures of the page itself
  // (a request blocked by an ad blocker…) were listed as errors of video-down.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Runtime.enable");
  const errors: string[] = [];
  cdp.on("Runtime.exceptionThrown", (e) => {
    const d = e.exceptionDetails;
    const frames = (d.stackTrace?.callFrames ?? []).map((f) => f.url);
    errors.push(`${(d.exception?.description ?? d.text).split("\n")[0]} | at ${d.url ?? ""} | ${frames.join(" ")}`);
  });
  // Blocked the way an ad blocker blocks it.
  await page.route("**/ads/**", (route) => route.abort("blockedbyclient"));
  await page.goto(`${baseUrl}/page-errors.html`);
  await expect(page).toHaveTitle("done: fetch ok, xhr ok, push ok", { timeout: 10_000 });
  await page.waitForTimeout(500);
  expect(errors.length, errors.join("\n")).toBeGreaterThanOrEqual(4);
  for (const error of errors) expect(error).not.toContain("chrome-extension://");
  await cdp.detach();
});

test("tiny decorative videos get no icon", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/tiny.html`);
  await page.waitForTimeout(1500);
  await expect(hub(page)).toBeHidden();
  await expect(trigger(page)).toBeHidden();
});

test("keyboard: the icon unfolds with Enter, Escape closes the menu and then folds it back", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/direct.html`);
  await hub(page).focus();
  await page.keyboard.press("Enter");
  await expect(trigger(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(hub(page)).toBeFocused();
  await expect(trigger(page)).toBeHidden();
});

// ---------------------------------------------------------------- online (opt-in)

test("4 · YouTube through the native component, saved where Chrome saves (VD_E2E_ONLINE=1)", async ({ page, downloads }) => {
  test.skip(process.env.VD_E2E_ONLINE !== "1", "needs Internet and the installed native component");
  // YouTube sometimes serves a consent page or an ad first: if no icon shows, load it once more.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto("https://www.youtube.com/watch?v=jNQXAC9IVRw");
    for (const label of [/Accept all/i, /Aceptar todo/i]) {
      const consent = page.getByRole("button", { name: label });
      if (await consent.count()) {
        await consent.first().click();
        break;
      }
    }
    const shown = await hub(page).first().waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false);
    if (shown) break;
  }
  await openDownload(page);
  // A whole video on a real MSE player: its duration does not grow, so it is not taken for a live one.
  await expect(recButton(page)).toBeHidden();
  await expect(menu(page).getByText(/native component/i)).toBeVisible({ timeout: 60_000 });
  await menu(page).getByRole("button", { name: /^144p/ }).click();
  await expect(menu(page).getByText("Download finished")).toBeVisible({ timeout: 120_000 });
  const saved = (await menu(page).locator(".vd-path").first().textContent())?.trim() ?? "";
  // yt-dlp writes where Chrome decided: its download folder (in these tests Chrome gives the file a
  // random name; in a normal Chrome it is "Me at the zoo 144p.mp4").
  expect(saved.startsWith(downloads)).toBe(true);
  expect(saved).toMatch(/\.mp4$/);
  const info = probe(saved);
  expect(info).toMatchObject({ height: 144, video: "h264", audio: "aac" });
  rmSync(saved, { force: true });
});

test("6 · large HLS is handed to the native component (VD_E2E_NATIVE=1)", async ({ page, baseUrl, extContext }) => {
  test.skip(process.env.VD_E2E_NATIVE !== "1", "needs the installed native component");
  const worker = extContext.serviceWorkers()[0]!;
  await worker.evaluate(() => chrome.storage.local.set({ storage_config: { preferNativeAboveMb: 0 } }));
  try {
    await page.goto(`${baseUrl}/hls.html`);
    await openDownload(page);
    await menu(page).getByRole("button", { name: /720p/ }).click({ timeout: 15_000 });
    await expect(menu(page).getByText("yt-dlp")).toBeVisible({ timeout: 30_000 });
    await expect(menu(page).getByText("Download finished")).toBeVisible({ timeout: 120_000 });
    const saved = (await menu(page).locator(".vd-path").first().textContent())?.trim() ?? "";
    expect(probe(saved)).toMatchObject({ height: 720, video: "h264", audio: "aac" });
    rmSync(saved, { force: true });
  } finally {
    await worker.evaluate(() => chrome.storage.local.remove("storage_config"));
  }
});

// ---------------------------------------------------------------- second opinion: yt-dlp (opt-in)

function installedYtdlp(): string | null {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? "", "video-down/bin/yt-dlp.exe"),
    join(homedir(), "Library/Application Support/video-down/bin/yt-dlp"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

test("parity · the menu lists the same HLS and DASH resolutions as yt-dlp (VD_E2E_NATIVE=1)", async ({ page, baseUrl }) => {
  test.skip(process.env.VD_E2E_NATIVE !== "1", "needs the installed native component");
  const ytdlp = installedYtdlp();
  test.skip(!ytdlp, "yt-dlp not installed");
  for (const [pagePath, manifest] of [
    ["hls.html", "/media/hls/master.m3u8"],
    ["dash.html", "/media/dash/manifest.mpd"],
  ]) {
    // Asynchronous on purpose: the test server lives in this same process.
    const { stdout } = await execFileAsync(ytdlp!, ["-J", "--no-warnings", "--", `${baseUrl}${manifest}`], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const info = JSON.parse(stdout) as { formats: Array<{ height?: number; vcodec?: string }> };
    const theirs = [...new Set(info.formats.filter((f) => f.height && f.vcodec !== "none").map((f) => f.height!))].sort(
      (a, b) => b - a,
    );
    await page.goto(`${baseUrl}/${pagePath}`);
    await openDownload(page);
    await expect(menu(page).getByRole("button", { name: /\d{3,4}p/ }).first()).toBeVisible({ timeout: 15_000 });
    const labels = await menu(page).locator(".vd-option-main").allTextContents();
    const ours = labels.map((l) => Number(l.match(/(\d{3,4})p/)?.[1])).filter(Boolean);
    expect(ours, `${pagePath}: video-down vs yt-dlp`).toEqual(theirs);
  }
});

test("9 · feed of a site behind a login: the post's own link, with the site's session (VD_E2E_NATIVE=1)", async ({ page, baseUrl, extContext }) => {
  test.skip(process.env.VD_E2E_NATIVE !== "1", "needs the installed native component");
  // The user is logged in to the site: the browser has its session cookie.
  await extContext.addCookies([{ name: "vdsession", value: "ok", domain: "127.0.0.1", path: "/" }]);
  try {
    await page.goto(`${baseUrl}/feed.html`);
    await openDownload(page);
    // yt-dlp does not know the feed, tries the post's link, is refused without a session (403)
    // and then gets the qualities with the site's cookies.
    await expect(menu(page).getByText(/using your session on this site/)).toBeVisible({ timeout: 90_000 });
    await expect(menu(page).getByText(/session\/post\.html/)).toBeVisible();
    await menu(page).locator(".vd-list button").first().click();
    // The video itself also needs the session: the download must get the cookies again.
    await expect(menu(page).getByText("Download finished")).toBeVisible({ timeout: 120_000 });
    const saved = (await menu(page).locator(".vd-path").first().textContent())?.trim() ?? "";
    expect(probe(saved)).toMatchObject({ height: 360, video: "h264", audio: "aac" });
    rmSync(saved, { force: true });
  } finally {
    await extContext.clearCookies();
  }
});

test("7 · the browser engine fails → the same job continues with yt-dlp (VD_E2E_NATIVE=1)", async ({ page, baseUrl }) => {
  test.skip(process.env.VD_E2E_NATIVE !== "1", "needs the installed native component");
  await page.goto(`${baseUrl}/hls-garbage.html`);
  await openDownload(page);
  await menu(page).getByRole("button", { name: /Original file/ }).click({ timeout: 15_000 });
  // The job row switches from "browser" to "yt-dlp" without the user doing anything.
  await expect(menu(page).locator(".vd-job .vd-option-meta", { hasText: "yt-dlp" })).toBeVisible({ timeout: 60_000 });
  // It reaches a final state through yt-dlp (with garbage input yt-dlp may still write a file:
  // it does not validate media). Remove whatever it saved: tests must not leave files behind.
  await expect(menu(page).locator(".vd-job").getByText(/Download finished|Error/)).toBeVisible({ timeout: 120_000 });
  const saved = (await menu(page).locator(".vd-path").first().textContent().catch(() => ""))?.trim();
  if (saved) rmSync(saved, { force: true });
});
