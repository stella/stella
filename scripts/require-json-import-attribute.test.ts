import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { rewriteFixture } from "./check-oxlint-fixture-counts.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const fixturePath =
  ".oxlint-plugins/__fixtures__/require-json-import-attribute.fixture.ts";
const ruleId = "require-json-import-attribute/require-json-import-attribute";
const reportSchema = v.object({
  diagnostics: v.array(
    v.object({
      code: v.string(),
      labels: v.array(v.object({ span: v.object({ line: v.number() }) })),
    }),
  ),
});

test("the JSON import fixture reports exactly its marked runtime imports", async () => {
  const fixture = rewriteFixture(
    fixturePath,
    await Bun.file(path.join(repositoryRoot, fixturePath)).text(),
  );
  expect(fixture.problems).toEqual([]);
  const directory = await mkdtemp(path.join(tmpdir(), "json-import-fixture-"));
  try {
    const input = path.join(directory, "subject.ts");
    const config = path.join(directory, "oxlint.config.ts");
    await Bun.write(input, fixture.source);
    await Bun.write(
      config,
      `export default ${JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [
          path.join(
            repositoryRoot,
            ".oxlint-plugins/require-json-import-attribute.ts",
          ),
        ],
        rules: { [ruleId]: "error" },
      })};`,
    );
    const process = Bun.spawn(
      ["bun", "--bun", "oxlint", "-c", config, "--format", "json", input],
      { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).not.toContain("Failed to load");
    const diagnostics = v.parse(reportSchema, JSON.parse(stdout)).diagnostics;
    const counts = new Map<string, number>();
    for (const diagnostic of diagnostics) {
      expect(diagnostic.code).toBe(
        "require-json-import-attribute(require-json-import-attribute)",
      );
      const line =
        diagnostic.labels.at(0)?.span.line ??
        panic("A JSON import diagnostic must identify its source line");
      const key = `${fixturePath}:${line}:${ruleId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of fixture.expected) {
      expect(counts.get(key) ?? 0).toBe(count);
    }
    expect([...counts.keys()].every((key) => fixture.expected.has(key))).toBe(
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
