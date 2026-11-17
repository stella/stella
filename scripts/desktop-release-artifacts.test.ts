import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const RENAME = path.join(import.meta.dir, "rename-desktop-artifacts.sh");
const MANIFEST = path.join(import.meta.dir, "build-updater-manifest.sh");
const VERSION = "1.2.3";
const TAG = "v1.2.3";

const workDirs: string[] = [];

const workDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "desktop-release-artifacts-"));
  workDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of workDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const run = (args: string[], env: Record<string, string> = {}) => {
  const result = Bun.spawnSync(["bash", ...args], {
    env: { ...process.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
};

const nsisBundle = (arch: "arm64" | "x64") => {
  const bundle = workDir();
  const nsis = path.join(bundle, "nsis");
  mkdirSync(nsis);
  for (const suffix of ["-setup.exe", "-setup.exe.sig"]) {
    writeFileSync(path.join(nsis, `Stella_${VERSION}_${arch}${suffix}`), "x");
  }
  return { bundle, nsis };
};

test.each([
  ["x86_64-pc-windows-msvc", "x64"],
  ["aarch64-pc-windows-msvc", "arm64"],
] as const)("names the %s installer and signature", (target, arch) => {
  const { bundle, nsis } = nsisBundle(arch);

  expect(run([RENAME, bundle, target]).exitCode).toBe(0);

  expect(readdirSync(nsis).toSorted()).toEqual([
    `Stella-windows-${arch}-setup.exe`,
    `Stella-windows-${arch}-setup.exe.sig`,
  ]);
});

test("keeps the macOS names for the universal target", () => {
  const bundle = workDir();
  const dmg = path.join(bundle, "dmg");
  mkdirSync(dmg);
  writeFileSync(path.join(dmg, `Stella_${VERSION}_universal.dmg`), "x");

  expect(run([RENAME, bundle, "universal-apple-darwin"]).exitCode).toBe(0);

  expect(existsSync(path.join(dmg, "Stella-macos-universal.dmg"))).toBe(true);
});

test("refuses a target with no stable names", () => {
  const { bundle, nsis } = nsisBundle("x64");

  const result = run([RENAME, bundle, "i686-pc-windows-msvc"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("no stable artifact names");
  expect(readdirSync(nsis)).toContain(`Stella_${VERSION}_x64-setup.exe`);
});

test("requires the target", () => {
  const { bundle } = nsisBundle("x64");

  expect(run([RENAME, bundle]).exitCode).not.toBe(0);
});

const signature = (asset: string, version = VERSION) =>
  Buffer.from(
    `untrusted comment: ${asset}\nsig\ntrusted comment: timestamp:1\tversion:${version}\n`,
  ).toString("base64");

/** Stands in for gh-retry.sh, serving one release's assets and signatures. */
const fakeGitHub = (assets: readonly string[], signedVersion = VERSION) => {
  const dir = workDir();
  const names = [...assets, ...assets.map((asset) => `${asset}.sig`)];
  const listing = names.map((name) => ({ apiUrl: `/assets/${name}`, name }));
  writeFileSync(path.join(dir, "assets.json"), JSON.stringify(listing));
  for (const asset of assets) {
    writeFileSync(
      path.join(dir, `${asset}.sig`),
      signature(asset, signedVersion),
    );
  }
  const script = path.join(dir, "gh-retry.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
if [[ "$1" == "release" ]]; then
  cat "${dir}/assets.json"
else
  cat "${dir}/$(basename "$2")"
fi
`,
  );
  chmodSync(script, 0o755);
  return script;
};

const buildManifest = (script: string) =>
  run([MANIFEST], {
    APP_VERSION: VERSION,
    GH_RETRY_SCRIPT: script,
    RELEASE_REF: TAG,
    REPO: "stella/stella",
  });

const assetUrl = (asset: string) =>
  `https://github.com/stella/stella/releases/download/${TAG}/${asset}`;

const X64 = "Stella-windows-x64-setup.exe";
const ARM64 = "Stella-windows-arm64-setup.exe";
const MACOS = "Stella-macos-universal.app.tar.gz";

test("lists every platform under the key its updater looks up", () => {
  const result = buildManifest(fakeGitHub([X64, ARM64, MACOS]));

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).platforms).toEqual({
    "darwin-aarch64": { signature: signature(MACOS), url: assetUrl(MACOS) },
    "darwin-x86_64": { signature: signature(MACOS), url: assetUrl(MACOS) },
    "windows-aarch64": { signature: signature(ARM64), url: assetUrl(ARM64) },
    "windows-x86_64": { signature: signature(X64), url: assetUrl(X64) },
  });
});

test("omits the ARM64 key for a release with no ARM64 installer", () => {
  const result = buildManifest(fakeGitHub([X64, MACOS]));

  expect(result.exitCode).toBe(0);
  expect(Object.keys(JSON.parse(result.stdout).platforms).toSorted()).toEqual([
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-x86_64",
  ]);
});

test("refuses an ARM64 signature bound to another version", () => {
  const result = buildManifest(fakeGitHub([ARM64], "9.9.9"));

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`${ARM64}.sig does not bind version`);
});

test("refuses a release with no updater archives", () => {
  const result = buildManifest(fakeGitHub([]));

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("No platform updater archives");
});
