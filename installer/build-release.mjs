// Build the distributable packages into release/:
//   video-down-setup-<version>.exe   Windows installer (Inno Setup 6)
//   video-down-<version>-macos.zip   macOS installer (double-click «Instalar video-down.command»)
//
// Usage (from the repository root):  node installer/build-release.mjs [--skip-build] [--skip-exe]
// Needs Node 22+, pnpm dependencies installed in extension/, and Inno Setup 6 for the .exe.
// No third-party packages: the zip writer below stores Unix permissions so the
// .command and .sh files stay executable after unzipping on a Mac.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = join(repo, "release");
const args = process.argv.slice(2);
const version = JSON.parse(readFileSync(join(repo, "extension/package.json"), "utf8")).version;
const versions = JSON.parse(readFileSync(join(repo, "installer/versions.json"), "utf8"));
if (versions.videodown !== version) {
  throw new Error(`installer/versions.json says ${versions.videodown} but extension/package.json says ${version}`);
}

// ------------------------------------------------------------------ version discipline
// A package with a given number must always contain the same code. So:
//  1. everything that goes into the package must be committed;
//  2. if v<version> was already published, the shipped code must be identical to it.
// To ship a change, raise the number first: node installer/set-version.mjs <x.y.z>
const SHIPPED = ["extension", "native-host", "installer"];
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--", ...SHIPPED) !== "") {
  throw new Error("There are uncommitted changes in extension/, native-host/ or installer/. Commit them before building packages.");
}
try {
  // Never wait for a passphrase or a host-key prompt: non-interactive and time-limited.
  execFileSync("git", ["fetch", "--tags", "--quiet"], {
    cwd: repo,
    stdio: "ignore",
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o ConnectTimeout=10",
    },
  });
} catch {
  console.warn("Could not fetch tags (offline?): checking local tags only.");
}
let published = "";
try {
  published = git("rev-parse", "-q", "--verify", `refs/tags/v${version}^{commit}`);
} catch {
  // not published yet
}
if (published) {
  try {
    execFileSync("git", ["diff", "--quiet", published, "HEAD", "--", ...SHIPPED], { cwd: repo });
  } catch {
    throw new Error(
      `v${version} is already published with different code. Raise the version first: node installer/set-version.mjs <new version>`,
    );
  }
}

const BOM = "\uFEFF";
const toCrlf = (s) => s.replace(/\r?\n/g, "\r\n");
const toLf = (s) => s.replace(/\r\n/g, "\n");

function copyText(from, to, transform) {
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, transform(readFileSync(from, "utf8")), "utf8");
}

function stageCommon(stage, lineEndings) {
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(join(repo, "extension/dist"), join(stage, "extension"), {
    recursive: true,
    filter: (src) => !src.endsWith(".map"),
  });
  for (const f of readdirSync(join(repo, "native-host/src"))) {
    if (f.endsWith(".ts")) copyText(join(repo, "native-host/src", f), join(stage, "native-host/src", f), toLf);
  }
  copyText(join(repo, "installer/versions.json"), join(stage, "versions.json"), lineEndings);
}

// ------------------------------------------------------------------ build the extension

if (!args.includes("--skip-build")) {
  console.log("Building the extension…");
  execFileSync(process.execPath, [join(repo, "extension/scripts/build.mjs"), "--mode", "production", "--release"], {
    cwd: join(repo, "extension"),
    stdio: "inherit",
  });
}
if (!existsSync(join(repo, "extension/dist/manifest.json"))) throw new Error("extension/dist is missing");
mkdirSync(release, { recursive: true });

// ------------------------------------------------------------------ Windows

const winStage = join(release, "stage-windows");
stageCommon(winStage, toCrlf);
// Windows PowerShell 5.1 reads BOM-less scripts as ANSI: add a BOM so accents survive.
for (const f of ["install.ps1", "uninstall.ps1"]) {
  copyText(join(repo, "installer/windows", f), join(winStage, f), (s) => BOM + toCrlf(s.replace(/^\uFEFF/, "")));
}
copyText(join(repo, "installer/windows/LEEME.txt"), join(winStage, "LEEME.txt"), (s) => BOM + toCrlf(s.replace(/^\uFEFF/, "")));

if (!args.includes("--skip-exe")) {
  const candidates = [
    process.env.ISCC,
    join(process.env.LOCALAPPDATA ?? "", "Programs/Inno Setup 6/ISCC.exe"),
    "C:/Program Files (x86)/Inno Setup 6/ISCC.exe",
    "C:/Program Files/Inno Setup 6/ISCC.exe",
  ].filter(Boolean);
  const iscc = candidates.find((p) => existsSync(p));
  if (!iscc) throw new Error("Inno Setup 6 (ISCC.exe) not found. Install it or pass --skip-exe.");
  console.log("Compiling the Windows installer…");
  execFileSync(
    iscc,
    [
      "/Qp",
      `/DAppVersion=${version}`,
      `/DStageDir=${winStage}`,
      `/DOutputDir=${release}`,
      join(repo, "installer/windows/video-down.iss"),
    ],
    { stdio: "inherit" },
  );
}

// ------------------------------------------------------------------ macOS

const macName = `video-down-${version}-macos`;
const macStage = join(release, "stage-macos", "video-down");
stageCommon(macStage, toLf);
for (const f of ["install.sh", "uninstall.sh", "Instalar video-down.command", "Desinstalar video-down.command"]) {
  copyText(join(repo, "installer/macos", f), join(macStage, f), toLf);
}
copyText(join(repo, "installer/macos/LEEME.txt"), join(macStage, "LEEME.txt"), toLf);

/** Minimal zip writer (deflate) that records Unix permissions for every entry. */
function zipDirectory(dir, rootName, outFile, isExecutable) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        files.push({ path: p, dir: true });
        walk(p);
      } else files.push({ path: p, dir: false });
    }
  };
  files.push({ path: dir, dir: true });
  walk(dir);

  const local = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const rel = relative(dir, f.path).split(sep).join("/");
    const name = Buffer.from(`${rootName}/${rel}${f.dir && rel ? "/" : ""}`.replace(/\/\/$/, "/"), "utf8");
    const data = f.dir ? Buffer.alloc(0) : readFileSync(f.path);
    const deflated = f.dir ? data : deflateRawSync(data, { level: 9 });
    const method = f.dir ? 0 : 8;
    const crc = f.dir ? 0 : crc32(data);
    const mode = f.dir ? 0o040755 : isExecutable(rel) ? 0o100755 : 0o100644;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(0, 10); // time/date
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(deflated.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, name, deflated);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(deflated.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(((mode << 16) | (f.dir ? 0x10 : 0)) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(outFile, Buffer.concat([...local, centralBuf, end]));
}

const macZip = join(release, `${macName}.zip`);
zipDirectory(macStage, "video-down", macZip, (rel) => rel.endsWith(".sh") || rel.endsWith(".command"));
console.log(`macOS package → ${macZip}`);
console.log("Done.");
