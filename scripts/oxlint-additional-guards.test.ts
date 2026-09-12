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
    const input = path.join(
      directory,
      `input.${source.includes("<Component") ? "tsx" : "ts"}`,
    );
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

describe("call argument boundaries", () => {
  test.each([
    'const payload: unknown = { id: "known" }; consume({ payload });',
    'const payload: unknown = { id: "known" }; consume([{ payload }]);',
    'const payload: unknown = { id: "known" }; consume(({ payload } as { payload: unknown })!);',
    'const payload: unknown = { id: "known" }; consume(<Component payload={payload} />);',
    'const payload: unknown = { id: "known" }; consume(<Component>{payload}</Component>);',
  ])(
    "treats nested argument values as contract boundaries: %s",
    async (source) => {
      expect(await lint(source)).toEqual([]);
    },
  );

  test.each([
    'const payload: unknown = { id: "known" }; consume({ payload: payload ?? fallback });',
    'const payload: unknown = { id: "known" }; consume({ onClose: () => payload });',
    'const payload: unknown = { id: "known" }; consume(<Component onClose={() => payload} />);',
  ])("does not treat nested computation as an argument: %s", async (source) => {
    expect(await lint(source)).toEqual([wideningCode]);
  });
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

describe("rejection parameter bindings", () => {
  test.each([
    "work().catch(({}) => recover());",
    "work().catch(([]) => recover());",
    "work().catch(({ detail: {} }) => recover());",
    "work().catch(([{}]) => recover());",
    "work().catch(({} = fallback) => recover());",
    "work().catch(({}, second) => recover(second));",
    "work().catch(([,], second) => recover(second));",
  ])("rejects patterns that bind no rejection reason: %s", async (source) => {
    expect(await lint(source)).toEqual([rejectionCode]);
  });

  test.each([
    "work().catch(({ message }) => recover(message));",
    "work().catch(([reason]) => recover(reason));",
    "work().catch(({ detail: { reason } = fallback }) => recover(reason));",
    "work().catch((reason = fallback) => recover(reason));",
    "work().catch((...reasons) => recover(reasons));",
    "work().catch(([...reasons]) => recover(reasons));",
    "type Context = {}; function handle(this: Context, reason) { recover(reason); } work().catch(handle);",
  ])("accepts patterns that bind a rejection reason: %s", async (source) => {
    expect(await lint(source)).toEqual([]);
  });
});
