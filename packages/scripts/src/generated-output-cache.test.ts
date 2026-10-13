import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
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
  const run = () =>
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
    const run = () =>
      withGeneratedOutputCache({
        root,
        name: "fixture",
        environment: "test",
        inputs: [],
        outputs: ["generated/*.txt"],
        generate: async () => {
          attempts += 1;
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
