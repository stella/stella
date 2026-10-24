import { panic } from "better-result";
import { expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { rejectionOf } from "@stll/property-testing/rejection";

import { withGeneratedOutputCache } from "./generated-output-cache";
import { withGenerationLock } from "./generation-lock";

test("a fresh generated-output run keeps status messages off stdout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "generated-cache-output-"));
  const runner = path.join(root, "run.ts");
  const cacheModule = pathToFileURL(
    path.join(import.meta.dirname, "generated-output-cache.ts"),
  ).href;
  await writeFile(path.join(root, "input.txt"), "value");
  await writeFile(
    runner,
    `import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { withGeneratedOutputCache } from ${JSON.stringify(cacheModule)};

const root = ${JSON.stringify(root)};
const output = path.join(root, "generated/value.txt");
await withGeneratedOutputCache({
  root,
  name: "fixture",
  environment: "test",
  inputs: ["input.txt"],
  outputs: ["generated/*.txt"],
  generate: async () => {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, await readFile(path.join(root, "input.txt")));
  },
});
`,
  );

  try {
    const child = Bun.spawn([process.execPath, runner], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^fixture: generated in \d+ ms\n$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation restores exact outputs and invalidates on source changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "generated-cache-"));
  let generations = 0;
  const output = path.join(root, "generated/value.txt");
  const generate = async () => {
    generations += 1;
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, await readFile(path.join(root, "input.txt")));
  };
  const run = async () =>
    withGeneratedOutputCache({
      root,
      name: "fixture",
      environment: "test",
      inputs: ["input.txt"],
      outputs: ["generated/*.txt"],
      generate,
    });
  try {
    await writeFile(path.join(root, "input.txt"), "first");
    await run();
    await writeFile(output, "edited");
    await run();
    expect(await readFile(output, "utf-8")).toBe("first");
    expect(generations).toBe(1);
    await rm(output);
    await run();
    expect(await readFile(output, "utf-8")).toBe("first");
    expect(generations).toBe(1);
    await writeFile(path.join(root, "input.txt"), "second");
    await run();
    expect(await readFile(output, "utf-8")).toBe("second");
    expect(generations).toBe(2);
    await writeFile(path.join(root, "generated/obsolete.txt"), "obsolete");
    await writeFile(path.join(root, "input.txt"), "first");
    await run();
    expect(await readFile(output, "utf-8")).toBe("first");
    expect(
      await Bun.file(path.join(root, "generated/obsolete.txt")).exists(),
    ).toBe(false);
    expect(generations).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed generation never becomes a cache hit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "generated-cache-failure-"));
  let attempts = 0;
  try {
    const output = path.join(root, "generated/value.txt");
    await writeFile(path.join(root, "input.txt"), "successful");
    await withGeneratedOutputCache({
      root,
      name: "fixture",
      environment: "test",
      inputs: ["input.txt"],
      outputs: ["generated/*.txt"],
      generate: async () => {
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, "successful");
      },
    });
    const cacheRoot = path.join(root, ".cache/generated-output/fixture");
    const successfulIdentity = (await readdir(cacheRoot)).find((entry) =>
      /^[a-f0-9]{64}$/u.test(entry),
    );
    if (successfulIdentity === undefined) {
      panic("Missing successful cache identity");
    }
    await writeFile(path.join(root, "input.txt"), "failed");
    const run = async () =>
      withGeneratedOutputCache({
        root,
        name: "fixture",
        environment: "test",
        inputs: ["input.txt"],
        outputs: ["generated/*.txt"],
        generate: async () => {
          attempts += 1;
          await mkdir(path.dirname(output), { recursive: true });
          await writeFile(output, "partial");
          panic("Fixture generation failed");
        },
      });
    expect(await rejectionOf(run())).toMatchObject({
      message: "Generation failed: fixture",
    });
    expect(await rejectionOf(run())).toMatchObject({
      message: "Generation failed: fixture",
    });
    expect(attempts).toBe(2);
    expect(await readdir(cacheRoot)).toEqual([successfulIdentity]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains the current and most recently used successful identities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "generated-cache-prune-"));
  const output = path.join(root, "generated/value.txt");
  const cacheRoot = path.join(root, ".cache/generated-output/fixture");
  const run = async () =>
    withGeneratedOutputCache({
      root,
      name: "fixture",
      environment: "test",
      inputs: ["input.txt"],
      outputs: ["generated/*.txt"],
      generate: async () => {
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, await readFile(path.join(root, "input.txt")));
      },
    });
  const identityFor = async (value: string) => {
    const entries = await readdir(cacheRoot);
    for (const entry of entries.filter((name) =>
      /^[a-f0-9]{64}$/u.test(name),
    )) {
      if (
        (await readFile(
          path.join(cacheRoot, entry, "generated/value.txt"),
          "utf-8",
        )) === value
      ) {
        return entry;
      }
    }
    throw new TypeError(`No cache identity contains ${value}`);
  };
  try {
    await writeFile(path.join(root, "input.txt"), "first");
    await run();
    const first = await identityFor("first");
    await writeFile(path.join(root, "input.txt"), "second");
    await run();
    const second = await identityFor("second");

    // Pin old timestamps so the hit itself must make `first` recent.
    const old = new Date(1000);
    const older = new Date(2000);
    utimesSync(path.join(cacheRoot, first, "manifest.json"), old, old);
    utimesSync(path.join(cacheRoot, second, "manifest.json"), older, older);
    await writeFile(path.join(root, "input.txt"), "first");
    await run();

    const incomplete = "f".repeat(64);
    await mkdir(path.join(cacheRoot, incomplete), { recursive: true });
    await writeFile(path.join(cacheRoot, incomplete, "partial.txt"), "partial");

    await writeFile(path.join(root, "input.txt"), "third");
    await run();
    const third = await identityFor("third");
    expect(new Set(await readdir(cacheRoot))).toEqual(new Set([first, third]));
    expect(third).not.toBe(second);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("excluded inputs may change during generation while sources may not", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "generated-cache-"));
  const run = async (generate: () => Promise<void>) =>
    withGeneratedOutputCache({
      root,
      name: "fixture",
      environment: "test",
      inputs: ["packages/**", "!packages/**/dist/**"],
      outputs: ["generated/*.txt"],
      generate,
    });
  const writeOutput = async () => {
    await mkdir(path.join(root, "generated"), { recursive: true });
    await writeFile(path.join(root, "generated/value.txt"), "value");
  };
  try {
    await mkdir(path.join(root, "packages/a/src"), { recursive: true });
    await mkdir(path.join(root, "packages/b/dist"), { recursive: true });
    await writeFile(path.join(root, "packages/a/src/index.ts"), "source");
    // Another package's build output appears mid-generation: not a source.
    await run(async () => {
      await writeFile(path.join(root, "packages/b/dist/index.js"), "built");
      await writeOutput();
    });
    expect(
      await readFile(path.join(root, "generated/value.txt"), "utf-8"),
    ).toBe("value");
    // A source changing mid-generation still refuses the result.
    await writeFile(path.join(root, "packages/a/src/index.ts"), "changed");
    const rejected = await rejectionOf(
      run(async () => {
        await writeFile(path.join(root, "packages/a/src/index.ts"), "again");
        await writeOutput();
      }),
    );
    expect(rejected).toMatchObject({ message: "Generation failed: fixture" });
    expect(Bun.inspect(rejected)).toContain(
      "Generator fixture changed its source inputs",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a caller that waited for the lock hashes the inputs it finds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "generated-cache-"));
  const output = path.join(root, "generated/value.txt");
  const run = async () =>
    withGeneratedOutputCache({
      root,
      name: "fixture",
      environment: "test",
      inputs: ["input.txt"],
      outputs: ["generated/*.txt"],
      generate: async () => {
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, await readFile(path.join(root, "input.txt")));
      },
    });
  try {
    await writeFile(path.join(root, "input.txt"), "first");
    await run();
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = withGenerationLock({
      lockPath: path.join(root, ".cache/generated-output/fixture.sqlite"),
      run: async () => {
        locked();
        await released;
      },
    });
    await holding;
    // This caller has a cache entry for "first" and now waits for the lock.
    const waiting = run();
    await writeFile(path.join(root, "input.txt"), "second");
    release();
    expect((await holder).isOk()).toBe(true);
    await waiting;
    expect(await readFile(output, "utf-8")).toBe("second");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
