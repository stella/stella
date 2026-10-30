import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const guard = path.join(
  import.meta.dirname,
  "../src/tests/fetch-global-guard.ts",
);

const runFixtures = (sources: readonly string[]) => {
  const directory = mkdtempSync(path.join(tmpdir(), "api-fetch-guard-"));
  const fixtures = sources.map((source, index) => {
    const fixture = path.join(
      directory,
      `fetch-guard-fixture-${index}.test.ts`,
    );
    writeFileSync(fixture, source);
    return fixture;
  });
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", "--preload", guard, ...fixtures],
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

const runFixture = (source: string) => runFixtures([source]);

const fetchReplacement =
  "Object.assign(async () => new Response(), { preconnect: () => undefined })";

test("reports the file that leaks a global fetch replacement", () => {
  const fixture = runFixture(`
    import { test } from "bun:test";
    test("leaks fetch", () => { globalThis.fetch = ${fetchReplacement}; });
  `);

  expect(fixture.exitCode).not.toBe(0);
  expect(fixture.output).toContain("fetch-guard-fixture-0.test.ts");
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

test("keeps a beforeAll replacement for every test in its scope", () => {
  const fixture = runFixture(`
    import { beforeAll, describe, expect, test } from "bun:test";
    const processFetch = globalThis.fetch;
    describe("fetch scope", () => {
      beforeAll(() => { globalThis.fetch = ${fetchReplacement}; });
      test("first", () => expect(globalThis.fetch).not.toBe(processFetch));
      test("second", () => expect(globalThis.fetch).not.toBe(processFetch));
    });
  `);

  expect(fixture.exitCode).toBe(0);
});

test("restores a module-scope replacement when its file ends", () => {
  const fixture = runFixture(`
    import { expect, test } from "bun:test";
    const processFetch = globalThis.fetch;
    globalThis.fetch = ${fetchReplacement};
    test("uses replacement", () => expect(globalThis.fetch).not.toBe(processFetch));
  `);

  expect(fixture.exitCode).toBe(0);
});

test("restores an in-test replacement before the next test", () => {
  const fixture = runFixture(`
    import { expect, test } from "bun:test";
    test("replaces fetch", () => { globalThis.fetch = ${fetchReplacement}; });
    test("uses process fetch", () => expect(globalThis.fetch.name).toBe("fetch"));
  `);

  expect(fixture.exitCode).not.toBe(0);
  expect(fixture.output).toContain("leaked a replacement globalThis.fetch");
  expect(fixture.output).not.toContain('expected: "fetch"');
});
