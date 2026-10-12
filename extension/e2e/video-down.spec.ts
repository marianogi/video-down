/**
 * End-to-end tests: the real extension (dist-e2e) loaded in Playwright's Chromium,
 * against local pages that reproduce each case of the routing table in README.md.
 *
 * Run with: pnpm run test:e2e   (builds dist-e2e and the media fixtures first)
 */

import { test as base, expect, chromium, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { startServer } from "./server.mjs";

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

test("1 · direct file: icon in the top-left corner and one entry per <source>", async ({ page, baseUrl, downloads }) => {
  await page.goto(`${baseUrl}/direct.html`);
  const button = trigger(page);
  await expect(button).toBeVisible();
  const v = await page.locator("video").boundingBox();
  const b = await button.boundingBox();
  expect(Math.abs(b!.x - (v!.x + 8))).toBeLessThan(3);
  expect(Math.abs(b!.y - (v!.y + 8))).toBeLessThan(3);

  await button.click();
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible();
  await expect(menu(page).getByRole("button", { name: /360p/ })).toBeVisible();
  await downloadAndCheck(page, downloads, /360p/, { height: 360 });
});

test("2 · HLS master: one entry per variant, merged with ffmpeg.wasm", async ({ page, baseUrl, downloads }) => {
  await page.goto(`${baseUrl}/hls.html`);
  await trigger(page).click();
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
  await expect(menu(page).getByRole("button", { name: /360p/ })).toBeVisible();
  await downloadAndCheck(page, downloads, /720p/, { height: 720 });
});

test("2b · HLS served without .m3u8 extension is recognised by Content-Type", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/hls-noext.html`);
  await trigger(page).click();
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
});

test("2c · HLS with AES-128 (not DRM) is decrypted and saved", async ({ page, baseUrl, downloads }) => {
  await page.goto(`${baseUrl}/hls-aes.html`);
  await trigger(page).click();
  await expect(menu(page).getByRole("button", { name: /Original file/ })).toBeVisible({ timeout: 15_000 });
  await downloadAndCheck(page, downloads, /Original file/, { height: 360 });
});

test("2d · HLS served as text/plain without extension is recognised by its content", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/odd-type.html`);
  await trigger(page).click();
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
});

test("2e · player in a cross-origin iframe whose CDN demands the player's Referer", async ({ page, baseUrl, downloads }) => {
  // Top page on localhost, player iframe on 127.0.0.1: two origins, as with any site embedding a
  // third-party player (course platforms, video hosts…) whose CDN checks the Referer.
  await page.goto(`http://localhost:${new URL(baseUrl).port}/embed-host.html`);
  const overlay = page.frameLocator("#player").locator("video-down-overlay");
  await overlay.getByRole("button", { name: /Download this video/ }).click();
  const m = overlay.getByRole("dialog");
  await expect(m.getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
  await downloadAndCheck(m, downloads, /360p/, { height: 360 });
});

test("2f · same, with variants and segments on another host that also checks the Referer", async ({ page, baseUrl, downloads }) => {
  await page.goto(`http://localhost:${new URL(baseUrl).port}/embed-host.html?player=player-cross.html`);
  const overlay = page.frameLocator("#player").locator("video-down-overlay");
  await overlay.getByRole("button", { name: /Download this video/ }).click();
  const m = overlay.getByRole("dialog");
  await expect(m.getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
  await downloadAndCheck(m, downloads, /720p/, { height: 720 });
});

test("3 · DASH: video representations listed, audio merged", async ({ page, baseUrl, downloads }) => {
  await page.goto(`${baseUrl}/dash.html`);
  await trigger(page).click();
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
  await expect(menu(page).getByRole("button", { name: /360p/ })).toBeVisible();
  await downloadAndCheck(page, downloads, /360p/, { height: 360 });
});

test("8a · DRM declared in the DASH manifest: warning, no resolutions", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/drm-dash.html`);
  await trigger(page).click();
  await expect(menu(page).getByText(/DRM-protected video/)).toBeVisible({ timeout: 15_000 });
  await expect(menu(page).getByText(/Widevine/)).toBeVisible();
  await expect(menu(page).getByRole("button", { name: /\d{3,4}p/ })).toHaveCount(0);
});

test("8b · DRM through EME on the element: lock icon and warning", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/drm-eme.html`);
  await expect(page).toHaveTitle("EME ready");
  const lock = trigger(page, /DRM-protected video/);
  await expect(lock).toBeVisible();
  await lock.click();
  await expect(menu(page).getByRole("alert")).toContainText(/DRM-protected video/);
  await expect(menu(page).getByRole("button", { name: /\d{3,4}p|Original/ })).toHaveCount(0);
});

test("5 · blob video with no manifest: no browser download is offered", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/unknown.html`);
  await trigger(page).click();
  // Either the native component is missing (explanation) or it is installed and yt-dlp
  // cannot read a local test page (error). In both cases no browser resolution is offered.
  await expect(
    menu(page).getByText(/native component is needed|was not found|could not read|ERROR|failed/i).first(),
  ).toBeVisible({ timeout: 30_000 });
});

test("tiny decorative videos get no icon", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/tiny.html`);
  await page.waitForTimeout(1500);
  await expect(trigger(page)).toBeHidden();
});

test("Escape closes the menu and returns focus to the icon", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/direct.html`);
  await trigger(page).click();
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});

// ---------------------------------------------------------------- online (opt-in)

test("4 · YouTube through the native component (VD_E2E_ONLINE=1)", async ({ page }) => {
  test.skip(process.env.VD_E2E_ONLINE !== "1", "needs Internet and the installed native component");
  await page.goto("https://www.youtube.com/watch?v=jNQXAC9IVRw");
  for (const label of [/Accept all/i, /Aceptar todo/i]) {
    const consent = page.getByRole("button", { name: label });
    if (await consent.count()) {
      await consent.first().click();
      break;
    }
  }
  await trigger(page).first().click();
  await expect(menu(page).getByText(/native component/i)).toBeVisible({ timeout: 60_000 });
  await menu(page).getByRole("button", { name: /^144p/ }).click();
  await expect(menu(page).getByText("Download finished")).toBeVisible({ timeout: 120_000 });
  const saved = (await menu(page).locator(".vd-path").first().textContent())?.trim() ?? "";
  expect(saved).toMatch(/Me at the zoo .*144p\.mp4$/);
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
    await trigger(page).click();
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
