import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { API } from "typescript/unstable/async";

import {
  type CompilerInputStamp,
  createCompilerInputRecorder,
} from "./compiler-input-stamp";
import {
  ABANDONED_TEMPORARY_MS,
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
const portableStamp = async (root: string): Promise<CompilerInputStamp> => {
  const recorder = createCompilerInputRecorder();
  const tsconfig = path.join(root, "tsconfig.json");
  const api = new API({ cwd: root, fs: recorder.fileSystem() });
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [tsconfig] });
    expect(
      await snapshot
        .getProject(tsconfig)
        ?.program.getSourceFile(path.join(root, "src/a.ts")),
    ).toBeDefined();
  } finally {
    await api.close();
  }
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
    stamp: await portableStamp(checkout),
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

test("checkouts reached through a symbolic link restore each other's output", async () => {
  const real = path.join(scratch, "real-a");
  renameSync(checkout, real);
  symlinkSync(real, checkout);
  publishGeneratedOutput({
    storeDir,
    stamp: await portableStamp(checkout),
    output: "printed",
  });
  const otherReal = path.join(scratch, "real-b");
  cpSync(real, otherReal, { recursive: true });
  const other = path.join(scratch, "checkout-b");
  symlinkSync(otherReal, other);

  expect((await restore(other))?.output.toString()).toBe("printed");
});

test("a checkout under other parents restores only while its ancestors resolve alike", async () => {
  write(checkout, "src/b.ts", 'export type { Extra } from "extra";\n');
  const publisher = path.join(scratch, "parent-a/repo");
  mkdirSync(path.dirname(publisher), { recursive: true });
  renameSync(checkout, publisher);
  publishGeneratedOutput({
    storeDir,
    stamp: await portableStamp(publisher),
    output: "printed",
  });
  const other = path.join(scratch, "parent-b/repo");
  cpSync(publisher, other, { recursive: true });
  expect((await restore(other))?.output.toString()).toBe("printed");

  // Only the receiving checkout's ancestors provide the unresolved import.
  write(
    path.join(other, ".."),
    "node_modules/extra/package.json",
    JSON.stringify({ name: "extra", types: "index.d.ts" }),
  );
  write(
    path.join(other, ".."),
    "node_modules/extra/index.d.ts",
    "export type Extra = string;\n",
  );
  expect(await restore(other)).toBeUndefined();

  // A deeper checkout restores while the ancestors the publisher never probed
  // provide nothing (compiler-input-stamp tests cover one that does).
  const deeper = path.join(scratch, "parent-c/deeper/repo");
  cpSync(publisher, deeper, { recursive: true });
  expect((await restore(deeper))?.output.toString()).toBe("printed");
});

test("a changed source or dependency misses", async () => {
  publishGeneratedOutput({
    storeDir,
    stamp: await portableStamp(checkout),
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
    stamp: await portableStamp(checkout),
    output: "printed",
  });
  expect(await restore(checkout, "other-context")).toBeUndefined();
});

test("restores the entry that matches when several are stored", async () => {
  publishGeneratedOutput({
    storeDir,
    stamp: await portableStamp(checkout),
    output: "first",
  });
  write(checkout, "src/a.ts", "export type A = number;\n");
  publishGeneratedOutput({
    storeDir,
    stamp: await portableStamp(checkout),
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
    stamp: await portableStamp(checkout),
    output: "printed",
  });
  const [entry] = readdirSync(storeDir);
  writeFileSync(path.join(storeDir, entry ?? "", "output"), "torn");
  expect(await restore(checkout)).toBeUndefined();
});

test("publishing the same output twice keeps one entry", async () => {
  const stamp = await portableStamp(checkout);
  publishGeneratedOutput({ storeDir, stamp, output: "printed" });
  publishGeneratedOutput({ storeDir, stamp, output: "printed" });
  expect(readdirSync(storeDir)).toHaveLength(1);
});

test("keeps at most KEEP_ENTRIES entries, dropping the least recently used", async () => {
  const source = 'import type { Dep } from "dep";\nexport type A = Dep;\n';
  publishGeneratedOutput({
    storeDir,
    stamp: await portableStamp(checkout),
    output: "kept",
  });
  const [kept = ""] = readdirSync(storeDir);
  write(checkout, "src/a.ts", "export type A = number;\n");
  const other = await portableStamp(checkout);
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

test("an entry that cannot be inspected is skipped and pruned first", async () => {
  publishGeneratedOutput({
    storeDir,
    stamp: await portableStamp(checkout),
    output: "printed",
  });
  // A self-referential link: inspecting it fails with ELOOP.
  symlinkSync("looped", path.join(storeDir, "looped"));
  expect((await restore(checkout))?.output.toString()).toBe("printed");

  write(checkout, "src/a.ts", "export type A = number;\n");
  const other = await portableStamp(checkout);
  for (let index = 1; index < KEEP_ENTRIES; index += 1) {
    publishGeneratedOutput({
      storeDir,
      stamp: other,
      output: `other ${index}`,
    });
  }
  const entries = readdirSync(storeDir);
  expect(entries).toHaveLength(KEEP_ENTRIES);
  expect(entries).not.toContain("looped");
});

test("publishing removes temporaries abandoned by a dead process", async () => {
  mkdirSync(storeDir, { recursive: true });
  const abandoned = path.join(storeDir, ".entry.4242.tmp");
  const active = path.join(storeDir, ".entry.4343.tmp");
  mkdirSync(abandoned);
  mkdirSync(active);
  const old = new Date(Date.now() - ABANDONED_TEMPORARY_MS - 60_000);
  utimesSync(abandoned, old, old);

  publishGeneratedOutput({
    storeDir,
    stamp: await portableStamp(checkout),
    output: "printed",
  });
  const entries = readdirSync(storeDir);
  expect(entries).not.toContain(".entry.4242.tmp");
  expect(entries).toContain(".entry.4343.tmp");
});
