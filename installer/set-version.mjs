// Raise the version everywhere at once: extension/package.json (single source),
// installer/versions.json, and a new section at the top of CHANGELOG.md.
// The extension manifest and the native component take it from there at build/install time.
//
// Usage: node installer/set-version.mjs 0.1.4

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(next ?? "")) {
  console.error("Usage: node installer/set-version.mjs <major.minor.patch>");
  process.exit(1);
}

const pkgPath = join(repo, "extension/package.json");
const pkg = readFileSync(pkgPath, "utf8");
const current = JSON.parse(pkg).version;
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
if (!newer(next, current)) {
  console.error(`${next} is not newer than the current ${current}.`);
  process.exit(1);
}
writeFileSync(pkgPath, pkg.replace(`"version": "${current}"`, `"version": "${next}"`));

const versionsPath = join(repo, "installer/versions.json");
const versions = readFileSync(versionsPath, "utf8");
writeFileSync(versionsPath, versions.replace(/"videodown": "[^"]+"/, `"videodown": "${next}"`));

const changelogPath = join(repo, "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");
if (!changelog.includes(`## ${next} `)) {
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(changelogPath, changelog.replace("\n## ", `\n## ${next} (${today})\n\n- \n\n## `));
}
console.log(`${current} → ${next}. Write the changes in CHANGELOG.md, commit, then build the packages.`);
