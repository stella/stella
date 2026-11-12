import { panic } from "better-result";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Builds `stella-pkcs11-helper` for a macOS bundle and, in a signed build,
 * signs it with its own entitlements before Tauri bundles the app.
 *
 * The helper loads smart card vendors' PKCS #11 modules, which their vendors
 * sign, not stella. Under the hardened runtime that needs
 * `com.apple.security.cs.disable-library-validation`, and only the helper
 * gets it: the app keeps library validation. Tauri signs its own binaries
 * and external binaries with the app's entitlements, so the helper is
 * bundled through `bundle.macOS.files` instead, which Tauri copies as is,
 * signature included; the app's own signature then seals it, and Tauri
 * notarizes the whole bundle.
 *
 * `tauri build` runs this before compiling the app and sets
 * `TAURI_ENV_TARGET_TRIPLE`; `--target <triple>` overrides it. A non-macOS
 * target has no helper and builds nothing. A universal target builds both
 * architectures and joins them with `lipo`. With `APPLE_SIGNING_IDENTITY`
 * set (as in the release workflow) the helper is signed with that identity,
 * the hardened runtime and a secure timestamp; without it, it is left as the
 * linker signed it, like the rest of an unsigned local build.
 *
 * Usage: `bun scripts/build-pkcs11-helper.ts [--target <triple>]`.
 */

const HELPER_NAME = "stella-pkcs11-helper";
const TAURI_DIR = path.resolve(import.meta.dir, "../src-tauri");
const MANIFEST = path.join(TAURI_DIR, "Cargo.toml");
const ENTITLEMENTS = path.join(TAURI_DIR, "Pkcs11HelperEntitlements.plist");
/** `bundle.macOS.files` in `tauri.sidecar.conf.json` names this file. */
const OUTFILE = path.join(TAURI_DIR, "binaries", HELPER_NAME);

const UNIVERSAL_MACOS = "universal-apple-darwin";
const MACOS_SLICES = ["aarch64-apple-darwin", "x86_64-apple-darwin"] as const;
type MacosSlice = (typeof MACOS_SLICES)[number];

const isMacosSlice = (triple: string): triple is MacosSlice =>
  MACOS_SLICES.some((slice) => slice === triple);

const targetTriple = () => {
  const flag = process.argv.indexOf("--target");
  const triple =
    flag === -1
      ? (process.env["TAURI_ENV_TARGET_TRIPLE"] ?? null)
      : (process.argv[flag + 1] ?? null);
  if (triple === null) {
    return panic(
      "build-pkcs11-helper: pass --target <triple> or run under `tauri build`",
    );
  }
  return triple;
};

const run = (command: readonly string[], failure: string) => {
  const result = Bun.spawnSync([...command], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    panic(`build-pkcs11-helper: ${failure}`);
  }
};

const compile = (slice: MacosSlice) => {
  run(
    [
      "cargo",
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      MANIFEST,
      "--package",
      HELPER_NAME,
      "--target",
      slice,
    ],
    `compiling for ${slice} failed`,
  );
  return path.join(TAURI_DIR, "target", slice, "release", HELPER_NAME);
};

const sign = (identity: string) => {
  run(
    [
      "codesign",
      "--force",
      "--sign",
      identity,
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      ENTITLEMENTS,
      OUTFILE,
    ],
    "signing failed",
  );
  run(
    ["codesign", "--verify", "--strict", "--verbose=2", OUTFILE],
    "the signature does not verify",
  );
};

const main = () => {
  const triple = targetTriple();
  if (triple !== UNIVERSAL_MACOS && !isMacosSlice(triple)) {
    console.log(`build-pkcs11-helper: ${triple} has no PKCS #11 helper`);
    return;
  }
  mkdirSync(path.dirname(OUTFILE), { recursive: true });
  rmSync(OUTFILE, { force: true });
  if (triple === UNIVERSAL_MACOS) {
    const slices = MACOS_SLICES.map(compile);
    run(
      ["lipo", "-create", "-output", OUTFILE, ...slices],
      "lipo could not join the macOS slices",
    );
  } else {
    copyFileSync(compile(triple), OUTFILE);
  }
  const identity = process.env["APPLE_SIGNING_IDENTITY"] ?? "";
  if (identity !== "") {
    sign(identity);
  }
  console.log(`build-pkcs11-helper: ${OUTFILE}`);
};

main();
