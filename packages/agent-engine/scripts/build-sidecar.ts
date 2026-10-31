import { panic } from "better-result";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

/**
 * Compiles the harness sidecar into the desktop bundle's external binary,
 * named as Tauri's `bundle.externalBin` expects: `<name>-<target triple>`,
 * with `.exe` on Windows. `tauri build` runs this before compiling the app
 * and sets `TAURI_ENV_TARGET_TRIPLE`; `--target <triple>` overrides it.
 *
 * A universal macOS build compiles both architectures and joins them with
 * `lipo`. Tauri copies the per-architecture binaries while it compiles each
 * slice of the app and the universal one when it bundles, so all three are
 * written.
 *
 * Usage: `bun scripts/build-sidecar.ts [--target <triple>]`.
 */

const SIDECAR_NAME = "stella-agent-sidecar";
const PACKAGE_DIR = path.resolve(import.meta.dir, "..");
const ENTRYPOINT = path.join(PACKAGE_DIR, "src/sidecar/main.ts");
const DESKTOP_TAURI_DIR = path.resolve(
  PACKAGE_DIR,
  "../../apps/desktop/src-tauri",
);
const OUT_DIR = path.join(DESKTOP_TAURI_DIR, "binaries");

/** Rust target triples the desktop ships, to Bun's compile targets. */
const BUN_TARGETS = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "aarch64-pc-windows-msvc": "bun-windows-arm64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
} as const satisfies Record<string, Bun.Build.CompileTarget>;
type CompiledTriple = keyof typeof BUN_TARGETS;

const UNIVERSAL_MACOS = "universal-apple-darwin";
const UNIVERSAL_SLICES = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
] as const satisfies readonly CompiledTriple[];

const isCompiledTriple = (triple: string): triple is CompiledTriple =>
  Object.hasOwn(BUN_TARGETS, triple);

const targetTriple = () => {
  const flag = process.argv.indexOf("--target");
  const triple =
    flag === -1
      ? (process.env["TAURI_ENV_TARGET_TRIPLE"] ?? null)
      : (process.argv[flag + 1] ?? null);
  if (triple === null) {
    return panic(
      "build-sidecar: pass --target <triple> or run under `tauri build`",
    );
  }
  return triple;
};

const outfile = (triple: string) =>
  path.join(
    OUT_DIR,
    `${SIDECAR_NAME}-${triple}${triple.includes("windows") ? ".exe" : ""}`,
  );

/** The version the desktop build was stamped with; the sidecar reports it. */
const desktopVersion = () =>
  v.parse(
    v.object({ version: v.string() }),
    JSON.parse(
      readFileSync(path.join(DESKTOP_TAURI_DIR, "tauri.conf.json"), "utf-8"),
    ),
  ).version;

const compile = async (triple: CompiledTriple, version: string) => {
  const file = outfile(triple);
  rmSync(file, { force: true });
  const built = await Bun.build({
    entrypoints: [ENTRYPOINT],
    minify: true,
    sourcemap: "none",
    define: {
      "process.env.STELLA_SIDECAR_VERSION": JSON.stringify(version),
    },
    compile: {
      target: BUN_TARGETS[triple],
      outfile: file,
      // The sidecar reads nothing from the directory it starts in.
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
  });
  if (!built.success) {
    for (const log of built.logs) {
      console.error(log);
    }
    return panic(`build-sidecar: compiling for ${triple} failed`);
  }
  return file;
};

const run = async () => {
  const triple = targetTriple();
  const version = desktopVersion();
  mkdirSync(OUT_DIR, { recursive: true });
  if (triple === UNIVERSAL_MACOS) {
    const slices: string[] = [];
    for (const slice of UNIVERSAL_SLICES) {
      slices.push(await compile(slice, version));
    }
    const universal = outfile(UNIVERSAL_MACOS);
    rmSync(universal, { force: true });
    const lipo = Bun.spawnSync(
      ["lipo", "-create", "-output", universal, ...slices],
      {
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    if (lipo.exitCode !== 0) {
      return panic("build-sidecar: lipo could not join the macOS slices");
    }
    console.log(`build-sidecar: ${universal}`);
    return;
  }
  if (!isCompiledTriple(triple)) {
    return panic(`build-sidecar: no Bun target for ${triple}`);
  }
  const file = await compile(triple, version);
  console.log(`build-sidecar: ${file}`);
};

await run();
