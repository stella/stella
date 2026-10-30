import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Compares a fresh build (scripts/build-wasm.sh with SCAN_ENGINE_WASM_OUT_DIR)
// against the committed bindings. Reads local files only.
const COMMITTED_DIR = path.join(import.meta.dir, "..", "generated");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== "--check") {
  fail("usage: bun scripts/check-wasm.ts --check");
}
const builtDir = process.env["SCAN_ENGINE_WASM_OUT_DIR"];
if (builtDir === undefined || builtDir === "") {
  fail(
    "SCAN_ENGINE_WASM_OUT_DIR must name the directory scripts/build-wasm.sh built into",
  );
}

const files = (dir: string) =>
  new Set(
    readdirSync(dir, { recursive: true, encoding: "utf-8" }).filter((file) =>
      statSync(path.join(dir, file)).isFile(),
    ),
  );

const committed = files(COMMITTED_DIR);
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
    const same = readFileSync(path.join(COMMITTED_DIR, file)).equals(
      readFileSync(path.join(builtDir, file)),
    );
    return same ? [] : [`differs: generated/${file}`];
  });

if (drift.length > 0) {
  fail(
    [
      "Committed WebAssembly bindings are out of date; run `bun run build:wasm` in packages/scan-engine.",
      ...drift,
    ].join("\n"),
  );
}
console.log(`generated/ matches the fresh build (${committed.size} files)`);
