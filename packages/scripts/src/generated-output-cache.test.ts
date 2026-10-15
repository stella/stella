import { panic } from "better-result";
import { expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  mkdir,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { withGeneratedOutputCache } from "./generated-output-cache";

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
