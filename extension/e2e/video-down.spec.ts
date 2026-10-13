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

test("2g · single-use playlist link: the player's own copy lists the qualities and the download works", async ({ page, baseUrl, downloads }) => {
  // The extension cannot read this master again (403), but the page's player already did.
  await page.goto(`${baseUrl}/once.html`);
  await trigger(page).click();
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 20_000 });
  await expect(menu(page).getByRole("button", { name: /360p/ })).toBeVisible();
  await downloadAndCheck(page, downloads, /360p/, { height: 360 });
});

test("2h · playlist in a platform's own encrypted format: explained, not broken", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/opaque.html`);
  await trigger(page).click();
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
    await trigger(page).click();
    await expect(menu(page).getByRole("button", { name: /Original file/ })).toBeVisible({ timeout: 15_000 });
    await downloadAndCheck(page, downloads, /Original file/, { height: 360 });
  });
}

test("2j · only one variant is requested: the master next to it is found and its qualities offered", async ({ page, baseUrl, downloads, extContext }) => {
  // Unified Origin names and a token on every playlist: the variants listed by the found master
  // must inherit the token of the playlist the player used.
  await page.goto(`${baseUrl}/hls-variant-only.html`);
  await trigger(page).click();
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
  await trigger(page).click();
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
  await expect(menu(page).getByRole("button", { name: /360p/ })).toBeVisible();
});

test("2l · single-page app loads another video: the previous one's qualities are gone", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/hls-spa.html`);
  await expect(page).toHaveTitle("second", { timeout: 15_000 });
  await trigger(page).click();
  await expect(menu(page).getByRole("button", { name: /Original file/ })).toBeVisible({ timeout: 15_000 });
  await expect(menu(page).getByRole("button", { name: /720p/ })).toHaveCount(0);
});

test("2m · playlists fetched by the page's service worker are recognised", async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/swtest/sw.html`);
  await expect(page).toHaveTitle("controlled", { timeout: 15_000 });
  await trigger(page).click();
  await expect(menu(page).getByRole("button", { name: /720p/ })).toBeVisible({ timeout: 15_000 });
  await expect(menu(page).getByRole("button", { name: /360p/ })).toBeVisible();
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
    await trigger(page).click();
    await expect(menu(page).getByRole("button", { name: /\d{3,4}p/ }).first()).toBeVisible({ timeout: 15_000 });
    const labels = await menu(page).locator(".vd-option-main").allTextContents();
    const ours = labels.map((l) => Number(l.match(/(\d{3,4})p/)?.[1])).filter(Boolean);
    expect(ours, `${pagePath}: video-down vs yt-dlp`).toEqual(theirs);
  }
});

test("7 · the browser engine fails → the same job continues with yt-dlp (VD_E2E_NATIVE=1)", async ({ page, baseUrl }) => {
  test.skip(process.env.VD_E2E_NATIVE !== "1", "needs the installed native component");
  await page.goto(`${baseUrl}/hls-garbage.html`);
  await trigger(page).click();
  await menu(page).getByRole("button", { name: /Original file/ }).click({ timeout: 15_000 });
  // The job row switches from "browser" to "yt-dlp" without the user doing anything.
  await expect(menu(page).locator(".vd-job .vd-option-meta", { hasText: "yt-dlp" })).toBeVisible({ timeout: 60_000 });
  // It reaches a final state through yt-dlp (with garbage input yt-dlp may still write a file:
  // it does not validate media). Remove whatever it saved: tests must not leave files behind.
  await expect(menu(page).locator(".vd-job").getByText(/Download finished|Error/)).toBeVisible({ timeout: 120_000 });
  const saved = (await menu(page).locator(".vd-path").first().textContent().catch(() => ""))?.trim();
  if (saved) rmSync(saved, { force: true });
});
