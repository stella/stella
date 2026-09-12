import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const wideningCode = "no-known-value-widening(no-known-value-widening)";
const rejectionCode = "no-swallowed-rejection(require-rejection-parameter)";
const diagnosticReport = v.object({
  diagnostics: v.array(v.object({ code: v.string() })),
});

const lint = async (source: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), "stella-oxlint-guards-"));
  try {
    const config = path.join(directory, "oxlint.config.ts");
    const input = path.join(directory, "input.ts");
    await Bun.write(
      config,
      `export default ${JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: ["no-known-value-widening", "no-swallowed-rejection"].map(
          (name) => path.join(repositoryRoot, ".oxlint-plugins", `${name}.ts`),
        ),
        rules: {
          "no-known-value-widening/no-known-value-widening": "error",
          "no-swallowed-rejection/require-rejection-parameter": "error",
        },
      })};`,
    );
    await Bun.write(input, source);
    const process = Bun.spawn(
      ["bun", "--bun", "oxlint", "-c", config, "--format", "json", input],
      {
        cwd: repositoryRoot,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect([0, 1]).toContain(exitCode);
    expect(stderr).not.toContain("Failed to load");
    return v
      .parse(diagnosticReport, JSON.parse(stdout))
      .diagnostics.map(({ code }) => code);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe("local type evidence", () => {
  test.each([
    'const value: unknown = { id: "known" };',
    'const value = { id: "known" } as object;',
    'const original = { id: "known" }; const value: unknown = original;',
    'type Boundary = unknown; const value: Boundary = { id: "known" };',
    "type MapType = Record<string, number>; const value: MapType = { count: 1 }; const narrowed = value as { count: number };",
    "type MapType = { [key: string]: number }; const value: MapType = { count: 1 }; const narrowed = value as { count: number };",
  ])("rejects erased local evidence: %s", async (source) => {
    expect(await lint(source)).toEqual([wideningCode]);
  });

  test.each([
    'const value: unknown = JSON.parse("{}");',
    "const value: unknown = loadExternal();",
    "const value: Record<string, unknown> = {}; value[dynamicKey] = 1;",
    'const value: Record<"count", number> = { count: 1 };',
    'import type { Record } from "domain-contract"; const value: Record<string, number> = { value: 1 }; const narrowed = value as { value: number };',
    'const value: Record<string, unknown> = { id: "known" }; send(value);',
    'const value: unknown = { id: "known" }; boundary(value);',
    'type Boundary = unknown; function closed() { type Boundary = { id: string }; const value: Boundary = { id: "known" }; return value; }',
    'type A = B; type B = A; const value: A = { id: "known" };',
    "type Key = Key | string; const value: Record<Key, number> = { count: 1 };",
    'const create = (): unknown => ({ id: "known" });',
  ])(
    "preserves explicit boundaries and lexical aliases: %s",
    async (source) => {
      expect(await lint(source)).toEqual([]);
    },
  );
});

describe("rejection ownership", () => {
  test.each([
    "work().catch(() => recover());",
    "const recover = () => notify(); const alias = recover; work().catch(alias);",
    "work().then(success, () => recover());",
    'work()["catch"]?.(() => recover());',
    "const original = work(); original.then(success, async () => { if (skip) return undefined; return await original; });",
    'Bun.file("input").text().catch(() => recover());',
  ])("requires a reason for recovery: %s", async (source) => {
    expect(await lint(source)).toEqual([rejectionCode]);
  });

  test.each([
    "work().catch((error) => recover(error));",
    'response.text().catch(() => "");',
    "reader.cancel().catch(() => undefined);",
    "const release = () => reset(); work().then(release, release);",
    "work().then(() => undefined, () => undefined);",
    "work().then(async () => await task(), async () => await task());",
    "const original = work(); original.then(success, async () => { reset(); return await original; });",
    "const recover = () => notify(); function run(recover) { return work().catch(recover); }",
  ])(
    "preserves teardown and outcome-agnostic sequencing: %s",
    async (source) => {
      expect(await lint(source)).toEqual([]);
    },
  );
});
