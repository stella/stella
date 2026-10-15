import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

import {
  type CompilerInputStamp,
  createCompilerInputRecorder,
} from "./compiler-input-stamp";
import {
  KEEP_ENTRIES,
  publishGeneratedOutput,
  restoreGeneratedOutput,
} from "./generated-output-store";

const CONTEXT = "context";
let scratch = "";
let checkout = "";
let storeDir = "";

const write = (root: string, file: string, source: string) => {
  const destination = path.join(root, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, source);
};

// Builds the fixture program the way the generator does and returns the
// portable stamp its inputs give.
const portableStamp = (root: string): CompilerInputStamp => {
  const recorder = createCompilerInputRecorder();
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(root, "tsconfig.json"),
    {},
    recorder.wrap({
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {
        throw new Error("unreadable tsconfig");
      },
    }),
  );
  if (config === undefined) {
    throw new Error("tsconfig not parsed");
  }
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: config.options,
    host: recorder.wrap(ts.createCompilerHost(config.options)),
  });
  expect(program.getSourceFile(path.join(root, "src/a.ts"))).toBeDefined();
  return recorder.portableStamp(CONTEXT, root);
};

const restore = async (root: string, context = CONTEXT) =>
  restoreGeneratedOutput({ storeDir, root, context });

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "generated-output-store-"));
  checkout = path.join(scratch, "checkout-a");
  storeDir = path.join(scratch, "store");
  write(
    checkout,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        types: [],
      },
      include: ["src"],
    }),
  );
  write(
    checkout,
    "src/a.ts",
    'import type { Dep } from "dep";\nexport type A = Dep;\n',
  );
  write(
    checkout,
    "node_modules/dep/package.json",
    JSON.stringify({ name: "dep", types: "index.d.ts" }),
  );
  write(checkout, "node_modules/dep/index.d.ts", "export type Dep = string;\n");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("another checkout with the same inputs restores the stored output", async () => {
  publishGeneratedOutput({
    storeDir,
    stamp: portableStamp(checkout),
    output: "printed",
  });
  const other = path.join(scratch, "checkout-b");
  cpSync(checkout, other, { recursive: true });
  // Another install writes the same dependency bytes at another time.
  const later = new Date(Date.now() + 60_000);
  utimesSync(path.join(other, "node_modules/dep/index.d.ts"), later, later);

  const restored = await restore(other);
  expect(restored?.output.toString()).toBe("printed");
  // The restored stamp names this checkout's files, not the publisher's.
  expect(Object.keys(restored?.stamp.contents ?? {})).toContain(
    path.join(other, "src/a.ts"),
  );
  expect(JSON.stringify(restored?.stamp)).not.toContain(checkout);
});

test("a changed source or dependency misses", async () => {
  publishGeneratedOutput({
    storeDir,
    stamp: portableStamp(checkout),
    output: "printed",
  });
  write(checkout, "src/a.ts", "export type A = number;\n");
  expect(await restore(checkout)).toBeUndefined();

  write(
    checkout,
    "src/a.ts",
    'import type { Dep } from "dep";\nexport type A = Dep;\n',
  );
  expect(await restore(checkout)).toBeDefined();
  write(checkout, "node_modules/dep/index.d.ts", "export type Dep = 1;\n");
  expect(await restore(checkout)).toBeUndefined();
});

test("another generation context misses", async () => {
  publishGeneratedOutput({
    storeDir,
    stamp: portableStamp(checkout),
    output: "printed",
  });
  expect(await restore(checkout, "other-context")).toBeUndefined();
});

test("restores the entry that matches when several are stored", async () => {
  publishGeneratedOutput({
    storeDir,
    stamp: portableStamp(checkout),
    output: "first",
  });
  write(checkout, "src/a.ts", "export type A = number;\n");
  publishGeneratedOutput({
    storeDir,
    stamp: portableStamp(checkout),
    output: "second",
  });
  expect((await restore(checkout))?.output.toString()).toBe("second");
  write(
    checkout,
    "src/a.ts",
    'import type { Dep } from "dep";\nexport type A = Dep;\n',
  );
  expect((await restore(checkout))?.output.toString()).toBe("first");
});

test("skips an entry whose output does not match its recorded hash", async () => {
  publishGeneratedOutput({
    storeDir,
    stamp: portableStamp(checkout),
    output: "printed",
  });
  const [entry] = readdirSync(storeDir);
  writeFileSync(path.join(storeDir, entry ?? "", "output"), "torn");
  expect(await restore(checkout)).toBeUndefined();
});

test("publishing the same output twice keeps one entry", () => {
  const stamp = portableStamp(checkout);
  publishGeneratedOutput({ storeDir, stamp, output: "printed" });
  publishGeneratedOutput({ storeDir, stamp, output: "printed" });
  expect(readdirSync(storeDir)).toHaveLength(1);
});

test("keeps at most KEEP_ENTRIES entries, dropping the least recently used", async () => {
  const source = 'import type { Dep } from "dep";\nexport type A = Dep;\n';
  publishGeneratedOutput({
    storeDir,
    stamp: portableStamp(checkout),
    output: "kept",
  });
  const [kept = ""] = readdirSync(storeDir);
  write(checkout, "src/a.ts", "export type A = number;\n");
  const other = portableStamp(checkout);
  for (let index = 1; index < KEEP_ENTRIES; index += 1) {
    publishGeneratedOutput({
      storeDir,
      stamp: other,
      output: `other ${index}`,
    });
  }
  // The store is full; the first entry is the oldest of all.
  for (const entry of readdirSync(storeDir)) {
    const age = entry === kept ? 7_200_000 : 3_600_000;
    const at = new Date(Date.now() - age);
    utimesSync(path.join(storeDir, entry), at, at);
  }
  write(checkout, "src/a.ts", source);
  expect((await restore(checkout))?.output.toString()).toBe("kept");

  publishGeneratedOutput({ storeDir, stamp: other, output: "one more" });
  const entries = readdirSync(storeDir);
  expect(entries).toHaveLength(KEEP_ENTRIES);
  // The restore marked it used, so an older unrestored entry went instead.
  expect(entries).toContain(kept);
});
