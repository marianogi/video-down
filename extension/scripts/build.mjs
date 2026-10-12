// Build the extension into dist/ with three Vite passes:
//  1. extension pages + service worker as ES modules (background, offscreen, popup, options)
//  2. content script as a single IIFE (content scripts cannot be ES modules)
//  3. main-world probe as a single IIFE
// then copy manifest.json and the ffmpeg.wasm core taken from node_modules
// (never a vendored binary: the version is pinned in package.json).
//
// Usage: node scripts/build.mjs [--mode development|production] [--watch]

import { build } from "vite";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "src");
const dist = resolve(root, process.argv.includes("--e2e") ? "dist-e2e" : "dist");
const args = process.argv.slice(2);
const mode = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "production";
const watch = args.includes("--watch");
// --release: build for a published package (only installer/build-release.mjs passes it).
// Any other build is labelled "<version>-dev (<commit>)" in chrome://extensions, so a test
// build can never be mistaken for a published version.
const release = args.includes("--release");
// --e2e: same build with an open shadow root so Playwright can reach the overlay.
const e2e = args.includes("--e2e");
const production = mode === "production";

const alias = {
  "@": src,
  "@host/protocol": resolve(root, "../native-host/src/protocol.ts"),
};

const shared = {
  configFile: false,
  mode,
  logLevel: process.env.VD_LOG || "warn",
  resolve: { alias },
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode),
    __VD_SHADOW_MODE__: JSON.stringify(e2e ? "open" : "closed"),
  },
};

rmSync(dist, { recursive: true, force: true });

// 1. Pages and service worker
await build({
  ...shared,
  root: src,
  publicDir: resolve(root, "public"),
  base: "./",
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  build: {
    outDir: dist,
    emptyOutDir: false,
    target: "es2022",
    minify: production,
    sourcemap: !production,
    watch: watch ? {} : null,
    rollupOptions: {
      input: {
        background: resolve(src, "service-worker.ts"),
        offscreen: resolve(src, "offscreen/offscreen.html"),
        popup: resolve(src, "popup/popup.html"),
        options: resolve(src, "options/options.html"),
      },
      output: {
        format: "es",
        entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});

// 2 + 3. Scripts injected into web pages
for (const [entry, file] of [
  ["content.ts", "content.js"],
  ["content/main-world.ts", "main-world.js"],
]) {
  await build({
    ...shared,
    root,
    publicDir: false,
    build: {
      outDir: dist,
      emptyOutDir: false,
      target: "es2022",
      minify: production,
      sourcemap: !production,
      watch: watch ? {} : null,
      lib: {
        entry: resolve(src, entry),
        formats: ["iife"],
        name: "videoDown",
        fileName: () => file,
      },
      rollupOptions: { output: { inlineDynamicImports: true, extend: true } },
    },
  });
}

// manifest.json with the version from package.json
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
manifest.version = pkg.version;
function commitLabel() {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "";
    return `${sha}${dirty ? "+cambios" : ""}`;
  } catch {
    return "sin git";
  }
}
manifest.version_name = release ? pkg.version : `${pkg.version}-dev (${commitLabel()})`;
writeFileSync(resolve(dist, "manifest.json"), JSON.stringify(manifest, null, 2));

// ffmpeg.wasm core (ESM build, loaded by the offscreen document)
const core = resolve(root, "node_modules/@ffmpeg/core/dist/esm");
if (!existsSync(resolve(core, "ffmpeg-core.wasm"))) {
  throw new Error("@ffmpeg/core is missing: run pnpm install");
}
mkdirSync(resolve(dist, "ffmpeg/core"), { recursive: true });
for (const f of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
  cpSync(resolve(core, f), resolve(dist, "ffmpeg/core", f));
}

console.log(`video-down ${manifest.version_name} built (${mode}) → ${dist}`);
