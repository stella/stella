import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const guard = path.join(
  import.meta.dirname,
  "../src/tests/fetch-global-guard.ts",
);

const runFixture = (source: string) => {
  const directory = mkdtempSync(path.join(tmpdir(), "api-fetch-guard-"));
  const fixture = path.join(directory, "fetch-guard-fixture.test.ts");
  writeFileSync(fixture, source);
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", "--preload", guard, fixture],
    cwd: path.join(import.meta.dirname, ".."),
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  rmSync(directory, { recursive: true, force: true });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
};

const fetchReplacement =
  "Object.assign(async () => new Response(), { preconnect: () => undefined })";

test("reports the file that leaks a global fetch replacement", () => {
  const fixture = runFixture(`
    import { test } from "bun:test";
    test("leaks fetch", () => { globalThis.fetch = ${fetchReplacement}; });
  `);

  expect(fixture.exitCode).not.toBe(0);
  expect(fixture.output).toContain("fetch-guard-fixture.test.ts");
  expect(fixture.output).toContain("leaked a replacement globalThis.fetch");
});

test("accepts a file that restores its global fetch replacement", () => {
  const fixture = runFixture(`
    import { test } from "bun:test";
    test("restores fetch", () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ${fetchReplacement};
      globalThis.fetch = originalFetch;
    });
  `);

  expect(fixture.exitCode).toBe(0);
  expect(fixture.output).not.toContain("leaked a replacement globalThis.fetch");
});
