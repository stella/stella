import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Compares a fresh WebAssembly build (a package's `scripts/build-wasm.sh`
 * writing into the directory `outDirEnv` names) against the package's
 * committed `generated/` bindings, and exits non-zero on any difference.
 * Reads local files only. Shared by every Rust WebAssembly package.
 */
export const checkGeneratedWasm = ({
  packageDir,
  outDirEnv,
}: {
  /** The package root, holding `generated/`. */
  packageDir: string;
  /** The environment variable naming the fresh build's directory. */
  outDirEnv: string;
}): void => {
  const fail = (message: string): never => {
    console.error(message);
    process.exit(1);
  };
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--check") {
    fail("usage: bun scripts/check-wasm.ts --check");
  }
  const builtDir = process.env[outDirEnv];
  if (builtDir === undefined || builtDir === "") {
    fail(
      `${outDirEnv} must name the directory scripts/build-wasm.sh built into`,
    );
    return;
  }
  const committedDir = path.join(packageDir, "generated");
  const files = (dir: string) =>
    new Set(
      readdirSync(dir, { recursive: true, encoding: "utf-8" }).filter((file) =>
        statSync(path.join(dir, file)).isFile(),
      ),
    );
  const committed = files(committedDir);
  const built = files(builtDir);
  const drift = [...new Set([...committed, ...built])]
    .toSorted()
    .flatMap((file) => {
      if (!built.has(file)) {
        return [`only committed: generated/${file}`];
      }
      if (!committed.has(file)) {
        return [`missing from generated/: ${file}`];
      }
      const same = readFileSync(path.join(committedDir, file)).equals(
        readFileSync(path.join(builtDir, file)),
      );
      return same ? [] : [`differs: generated/${file}`];
    });
  if (drift.length > 0) {
    fail(
      [
        `Committed WebAssembly bindings are out of date; run \`bun run build:wasm\` in packages/${path.basename(packageDir)}.`,
        ...drift,
      ].join("\n"),
    );
  }
  console.log(`generated/ matches the fresh build (${committed.size} files)`);
};
