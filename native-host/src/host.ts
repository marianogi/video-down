/**
 * video-down native messaging host (Deno).
 *
 * Chrome starts this process through the launcher written by the installer
 * (video-down-host.cmd on Windows, video-down-host.sh on macOS). The launcher
 * runs Deno with explicit permissions:
 *   --allow-read=<app dir>  --allow-write=<app dir>/state,tmp,logs
 *   --allow-run=<yt-dlp> (+ taskkill.exe on Windows)
 * so this script cannot touch anything else on disk even if it had a bug.
 *
 * One process serves one operation (ping, probe, download or update). When
 * the extension closes the port, stdin reaches EOF and the host stops any
 * running yt-dlp, removes its temporary files and exits. That is the cancel path.
 */

import { encodeMessage, FrameDecoder } from "./messaging.ts";
import {
  cookieFileText,
  cookieMatchesUrl,
  type DownloadRequest,
  type ErrorCode,
  type HostRequest,
  type HostResponse,
  parseRequest,
  PROTOCOL_VERSION,
  type ProbeRequest,
  type SessionCookie,
} from "./protocol.ts";
import { buildVariants, publicVariants, type StoredVariant, type YtdlpInfo } from "./variants.ts";
import {
  FILE_PREFIX,
  FORMAT_PREFIX,
  parseProgressLine,
  PROGRESS_TEMPLATE,
  ProgressTracker,
  summariseError,
} from "./progress.ts";


const IS_WINDOWS = Deno.build.os === "windows";
const EXE = IS_WINDOWS ? ".exe" : "";
const PROBE_TTL_MS = 6 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 90_000;

// ------------------------------------------------------------------ paths

function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i <= 0 ? path : path.slice(0, i);
}

function join(...parts: string[]): string {
  const sep = IS_WINDOWS ? "\\" : "/";
  return parts
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(sep);
}

function fileUrlToPath(url: string): string {
  const u = new URL(url);
  let p = decodeURIComponent(u.pathname);
  if (IS_WINDOWS) p = p.replace(/^\/([A-Za-z]:)/, "$1").replaceAll("/", "\\");
  return p;
}

/** <app dir>/native-host/src/host.ts → <app dir> */
const APP_DIR = dirname(dirname(dirname(fileUrlToPath(import.meta.url))));
const BIN_DIR = join(APP_DIR, "bin");
const STATE_DIR = join(APP_DIR, "state", "probes");
const TMP_DIR = join(APP_DIR, "tmp");
const LOG_FILE = join(APP_DIR, "logs", "host.log");

const YTDLP = join(BIN_DIR, `yt-dlp${EXE}`);
const FFMPEG = join(BIN_DIR, `ffmpeg${EXE}`);
const DENO = join(BIN_DIR, `deno${EXE}`);
const TASKKILL = "C:\\Windows\\System32\\taskkill.exe";

/**
 * The version is never written by hand here: it is the package version the installer
 * copied into <app dir>/versions.json (single source: extension/package.json).
 */
let cachedVersion: string | null = null;
export function hostVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const v = JSON.parse(Deno.readTextFileSync(join(APP_DIR, "versions.json")))?.videodown;
    cachedVersion = typeof v === "string" && v ? v : "dev";
  } catch {
    cachedVersion = "dev";
  }
  return cachedVersion;
}

interface HostConfig {
  downloadDir: string;
}

function readConfig(): HostConfig {
  const raw = JSON.parse(Deno.readTextFileSync(join(APP_DIR, "config.json")));
  if (typeof raw?.downloadDir !== "string" || raw.downloadDir.length === 0) {
    throw new Error("config.json has no downloadDir");
  }
  return { downloadDir: raw.downloadDir };
}

// ------------------------------------------------------------------ io

function log(...parts: unknown[]): void {
  try {
    const line = `${new Date().toISOString()} ${parts
      .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
      .join(" ")}\n`;
    try {
      if (Deno.statSync(LOG_FILE).size > 1024 * 1024) Deno.truncateSync(LOG_FILE, 0);
    } catch {
      // first write
    }
    Deno.writeTextFileSync(LOG_FILE, line, { append: true, create: true });
  } catch {
    // Logging must never break the protocol (stdout is reserved for Chrome).
  }
}

let stdoutClosed = false;

function send(message: HostResponse): void {
  if (stdoutClosed) return;
  try {
    const bytes = encodeMessage(message);
    let written = 0;
    while (written < bytes.length) {
      written += Deno.stdout.writeSync(bytes.subarray(written));
    }
  } catch (err) {
    // Chrome went away. Stop whatever is running instead of leaving an orphan.
    stdoutClosed = true;
    log("stdout closed", String(err));
    if (activeChild) killTree(activeChild);
  }
}

function fail(id: string, code: ErrorCode, message: string): void {
  send({ id, type: "error", code, message });
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ yt-dlp

/** Options shared by every yt-dlp call. URL always goes after "--". */
function baseArgs(): string[] {
  const args = [
    "--ignore-config",
    "--no-playlist",
    "--no-warnings",
    // Without it, yt-dlp on Windows writes its output in the console code page and the file path
    // it reports arrives mangled ("¡" became "�"): this host reads UTF-8.
    "--encoding",
    "utf-8",
    "--cache-dir",
    join(APP_DIR, "cache"),
    "--ffmpeg-location",
    BIN_DIR,
  ];
  if (exists(DENO)) args.push("--js-runtimes", `deno:${DENO}`);
  return args;
}

let activeChild: Deno.ChildProcess | null = null;
let activeTmpDir: string | null = null;

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += value;
    let nl: number;
    while ((nl = pending.search(/\r?\n/)) !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(pending[nl] === "\r" ? nl + 2 : nl + 1);
      onLine(line);
    }
  }
  if (pending) onLine(pending);
}

async function runYtdlp(
  args: string[],
  onStdoutLine?: (line: string) => void,
  timeoutMs?: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!exists(YTDLP)) throw Object.assign(new Error("yt-dlp is not installed"), { code: "missing-binary" });
  const child = new Deno.Command(YTDLP, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    windowsRawArguments: false,
  }).spawn();
  activeChild = child;

  let stdout = "";
  let stderr = "";
  const timer = timeoutMs ? setTimeout(() => killTree(child), timeoutMs) : undefined;
  try {
    await Promise.all([
      readLines(child.stdout, (line) => {
        if (onStdoutLine) onStdoutLine(line);
        else stdout += line + "\n";
      }),
      readLines(child.stderr, (line) => {
        stderr += line + "\n";
        if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
      }),
    ]);
    const status = await child.status;
    return { code: status.code, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
    activeChild = null;
  }
}

/** yt-dlp.exe is a PyInstaller bootloader with a child process: kill the whole tree. */
function killTree(child: Deno.ChildProcess): void {
  try {
    if (IS_WINDOWS) {
      new Deno.Command(TASKKILL, {
        args: ["/PID", String(child.pid), "/T", "/F"],
        stdout: "null",
        stderr: "null",
      }).outputSync();
    } else {
      child.kill("SIGTERM");
    }
  } catch (err) {
    log("kill failed", String(err));
  }
}

async function ytdlpVersion(): Promise<string | null> {
  if (!exists(YTDLP)) return null;
  try {
    const out = await new Deno.Command(YTDLP, { args: ["--version"], stdout: "piped", stderr: "null" }).output();
    return new TextDecoder().decode(out.stdout).trim() || null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ probes on disk

interface StoredProbe {
  probeId: string;
  url: string;
  referer?: string;
  title: string;
  createdAt: number;
  variants: StoredVariant[];
}

function probePath(probeId: string): string {
  return join(STATE_DIR, `${probeId}.json`);
}

function cleanOldProbes(): void {
  try {
    const now = Date.now();
    for (const entry of Deno.readDirSync(STATE_DIR)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const path = join(STATE_DIR, entry.name);
      const mtime = Deno.statSync(path).mtime?.getTime() ?? 0;
      if (now - mtime > PROBE_TTL_MS) Deno.removeSync(path);
    }
  } catch {
    // directory may not exist yet
  }
}

function sanitizeTitle(title: string): string {
  return title
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150) || "video";
}

/**
 * The site's session for one yt-dlp run: a file only this user can read, inside the job's own
 * temporary folder, which is removed when yt-dlp ends (also on cancel and at the next start).
 * Its contents are never logged.
 */
function writeCookieFile(dir: string, cookies: SessionCookie[]): string {
  const path = join(dir, "cookies.txt");
  Deno.writeTextFileSync(path, cookieFileText(cookies, Math.floor(Date.now() / 1000)), { mode: 0o600 });
  return path;
}

// ------------------------------------------------------------------ handlers

async function handlePing(id: string): Promise<void> {
  let downloadDir = "";
  try {
    downloadDir = readConfig().downloadDir;
  } catch {
    // reported as empty
  }
  send({
    id,
    type: "pong",
    protocol: PROTOCOL_VERSION,
    hostVersion: hostVersion(),
    ytdlpVersion: await ytdlpVersion(),
    ffmpeg: exists(FFMPEG),
    deno: exists(DENO),
    platform: Deno.build.os,
    downloadDir,
  });
}

async function handleProbe(req: ProbeRequest): Promise<void> {
  const args = [...baseArgs(), "-J", "--skip-download"];
  if (req.referer) args.push("--referer", req.referer);
  if (req.cookies?.length) {
    cleanStaleTmp();
    const tmp = join(TMP_DIR, `probe-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`);
    Deno.mkdirSync(tmp, { recursive: true });
    activeTmpDir = tmp;
    args.push("--cookies", writeCookieFile(tmp, req.cookies));
  }
  args.push("--", req.url);

  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await runYtdlp(args, undefined, PROBE_TIMEOUT_MS);
  } finally {
    await removeTmp();
  }
  const { code, stdout, stderr } = result;
  if (code !== 0) {
    const message = summariseError(stderr);
    const unsupported = /unsupported url/i.test(message);
    const drm = /drm/i.test(message);
    fail(req.id, drm ? "drm" : unsupported ? "unsupported-url" : "ytdlp-failed", message);
    return;
  }

  let info: YtdlpInfo;
  try {
    info = JSON.parse(stdout);
  } catch {
    fail(req.id, "ytdlp-failed", "yt-dlp returned invalid JSON");
    return;
  }

  const built = buildVariants(info);
  const probeId = crypto.randomUUID().replaceAll("-", "");
  const stored: StoredProbe = {
    probeId,
    url: req.url,
    title: built.title,
    createdAt: Date.now(),
    variants: built.variants,
  };
  if (req.referer) stored.referer = req.referer;

  Deno.mkdirSync(STATE_DIR, { recursive: true });
  cleanOldProbes();
  Deno.writeTextFileSync(probePath(probeId), JSON.stringify(stored));

  send({
    id: req.id,
    type: "probe-result",
    probeId,
    title: built.title,
    extractor: built.extractor,
    isLive: built.isLive,
    ...(built.duration ? { duration: built.duration } : {}),
    drm: built.drm,
    variants: publicVariants(built.variants),
  });
}

async function handleDownload(req: DownloadRequest): Promise<void> {
  let probe: StoredProbe;
  try {
    probe = JSON.parse(Deno.readTextFileSync(probePath(req.probeId)));
  } catch {
    fail(req.id, "not-found", "probe expired or unknown; open the menu again");
    return;
  }
  const variant = probe.variants.find((v) => v.id === req.variantId);
  if (!variant) {
    fail(req.id, "not-found", "unknown variant");
    return;
  }
  if (req.cookies && !req.cookies.every((c) => cookieMatchesUrl(c, probe.url))) {
    fail(req.id, "bad-request", "cookie for another site");
    return;
  }

  const config = readConfig();
  cleanStaleTmp();
  const jobId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const tmp = join(TMP_DIR, jobId);
  Deno.mkdirSync(tmp, { recursive: true });
  activeTmpDir = tmp;

  send({ id: req.id, type: "download-started", jobId, label: variant.label });

  const args = [
    ...baseArgs(),
    "-f",
    variant.selector,
    "--merge-output-format",
    "mp4",
    "--windows-filenames",
    "--trim-filenames",
    "180",
    "--no-mtime",
    "--concurrent-fragments",
    "4",
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "-P",
    `home:${req.saveTo?.dir ?? config.downloadDir}`,
    "-P",
    `temp:${tmp}`,
    "-o",
    req.saveTo ? `${req.saveTo.name}.%(ext)s` : `${sanitizeTitle(probe.title)} [%(id)s] ${variant.label}.%(ext)s`,
    "--newline",
    "--progress",
    "--progress-template",
    PROGRESS_TEMPLATE,
    "--print",
    `before_dl:${FORMAT_PREFIX}%(format_id)s`,
    "--print",
    `after_move:${FILE_PREFIX}%(filepath)s`,
  ];
  if (probe.referer) args.push("--referer", probe.referer);
  if (req.cookies?.length) args.push("--cookies", writeCookieFile(tmp, req.cookies));
  args.push("--", probe.url);

  const tracker = new ProgressTracker();
  let filepath: string | null = null;
  let lastSent = 0;

  const { code, stderr } = await runYtdlp(args, (line) => {
    if (line.startsWith(FORMAT_PREFIX)) {
      tracker.setFormatIds(line.slice(FORMAT_PREFIX.length));
      return;
    }
    if (line.startsWith(FILE_PREFIX)) {
      filepath = line.slice(FILE_PREFIX.length).trim();
      return;
    }
    const sample = parseProgressLine(line);
    if (!sample) return;
    const percent = tracker.update(sample);
    const now = Date.now();
    const merging = tracker.allPartsFinished();
    if (now - lastSent < 400 && sample.status !== "finished") return;
    lastSent = now;
    send({
      id: req.id,
      type: "progress",
      jobId,
      stage: merging ? "merging" : "downloading",
      percent,
      ...(sample.downloaded !== undefined ? { downloadedBytes: sample.downloaded } : {}),
      ...(sample.total !== undefined ? { totalBytes: sample.total } : {}),
      ...(sample.speed !== undefined ? { speed: sample.speed } : {}),
      ...(sample.eta !== undefined ? { eta: sample.eta } : {}),
    });
  });

  await removeTmp();
  if (code !== 0 || !filepath) {
    fail(req.id, "ytdlp-failed", summariseError(stderr));
    return;
  }
  send({ id: req.id, type: "done", jobId, filepath });
}

async function handleUpdate(id: string): Promise<void> {
  const { stdout, stderr } = await runYtdlp(["--ignore-config", "-U"], undefined, 120_000);
  send({
    id,
    type: "update-result",
    ytdlpVersion: await ytdlpVersion(),
    output: (stdout + stderr).trim().slice(-2000),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * On Windows a killed yt-dlp keeps its files open for a moment, so deleting
 * its temporary folder right away fails. Retry for a few seconds.
 */
async function removeTmp(): Promise<void> {
  const dir = activeTmpDir;
  if (!dir) return;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      Deno.removeSync(dir, { recursive: true });
      break;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) break;
      if (attempt === 19) log("could not remove", dir, String(err));
      await sleep(250);
    }
  }
  if (activeTmpDir === dir) activeTmpDir = null;
}

/** Remove job folders left by crashes: nothing inside them was written for 30 minutes. */
function cleanStaleTmp(): void {
  const now = Date.now();
  const newest = (dir: string): number => {
    let latest = Deno.statSync(dir).mtime?.getTime() ?? 0;
    for (const e of Deno.readDirSync(dir)) {
      const p = join(dir, e.name);
      latest = Math.max(latest, e.isDirectory ? newest(p) : (Deno.statSync(p).mtime?.getTime() ?? 0));
    }
    return latest;
  };
  try {
    for (const entry of Deno.readDirSync(TMP_DIR)) {
      if (!entry.isDirectory) continue;
      const dir = join(TMP_DIR, entry.name);
      // A probe folder only lives for one yt-dlp -J run (at most 90 s) and may hold cookies.
      const maxAge = entry.name.startsWith("probe-") ? 5 * 60_000 : 30 * 60_000;
      try {
        if (now - newest(dir) > maxAge) Deno.removeSync(dir, { recursive: true });
      } catch {
        // in use or already gone
      }
    }
  } catch {
    // TMP_DIR missing
  }
}

async function dispatch(req: HostRequest): Promise<void> {
  switch (req.type) {
    case "ping":
      return await handlePing(req.id);
    case "probe":
      return await handleProbe(req);
    case "download":
      return await handleDownload(req);
    case "update":
      return await handleUpdate(req.id);
  }
}

// ------------------------------------------------------------------ main loop

async function main(): Promise<void> {
  log("start", { version: hostVersion(), args: Deno.args.slice(0, 1) });
  const decoder = new FrameDecoder();
  const running: Promise<void>[] = [];
  const reader = Deno.stdin.readable.getReader();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    let messages: unknown[];
    try {
      messages = decoder.push(value);
    } catch (err) {
      log("bad frame", String(err));
      break;
    }
    for (const raw of messages) {
      const parsed = parseRequest(raw);
      if (!parsed.ok) {
        log("rejected", parsed.reason);
        fail(parsed.id ?? "unknown", "bad-request", parsed.reason);
        continue;
      }
      const job = dispatch(parsed.value).catch((err) => {
        log("handler error", String(err?.stack ?? err));
        const code: ErrorCode = err?.code === "missing-binary" ? "missing-binary" : "internal";
        fail(parsed.value.id, code, String(err?.message ?? err));
      });
      running.push(job);
    }
  }

  // stdin closed: the extension disconnected (cancel or service worker gone).
  if (activeChild) {
    log("port closed during a job; stopping yt-dlp");
    killTree(activeChild);
  }
  await Promise.allSettled(running);
  await removeTmp();
  log("exit");
}

/** Used by the installers: prints the state of every binary and exits non-zero if one is missing. */
async function selfCheck(): Promise<number> {
  let downloadDir = "";
  try {
    downloadDir = readConfig().downloadDir;
  } catch {
    // reported as empty
  }
  const status = {
    hostVersion: hostVersion(),
    ytdlpVersion: await ytdlpVersion(),
    ffmpeg: exists(FFMPEG),
    deno: exists(DENO),
    downloadDir,
  };
  console.log(JSON.stringify(status));
  return status.ytdlpVersion && status.ffmpeg && status.deno && downloadDir ? 0 : 1;
}

if (import.meta.main) {
  if (Deno.args.includes("--self-check")) Deno.exit(await selfCheck());
  await main();
  Deno.exit(0);
}
