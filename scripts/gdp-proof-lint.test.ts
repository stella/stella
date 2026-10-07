import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const reportSchema = v.object({
  diagnostics: v.array(v.object({ message: v.string() })),
});
type LintOptions = {
  ruleNames: string[];
  pluginSpecifier?: string;
};
const lint = async (
  source: string,
  {
    ruleNames,
    pluginSpecifier = path.join(
      import.meta.dir,
      "oxlint-presets/gdp-plugin.mjs",
    ),
  }: LintOptions,
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "stella-proof-lint-"));
  try {
    const input = path.join(directory, "input.ts");
    const config = path.join(directory, "oxlint.config.ts");
    await Bun.write(input, source);
    await Bun.write(
      config,
      `export default ${JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [
          {
            name: "gdp-ts",
            specifier: pluginSpecifier,
          },
        ],
        rules: Object.fromEntries(
          ruleNames.map((rule) => [`gdp-ts/${rule}`, "error"]),
        ),
      })};`,
    );
    const child = Bun.spawn(
      ["bun", "--bun", "oxlint", "-c", config, "--format", "json", input],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect([0, 1]).toContain(status);
    expect(stderr).not.toContain("Failed to load");
    return v.parse(reportSchema, JSON.parse(stdout)).diagnostics;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
const messages = async (source: string, ruleNames: string[]) =>
  (await lint(source, { ruleNames })).map(({ message }) => message);

describe("GDP proof anti-forgery rules", () => {
  test("upstream rejects renamed imports while the wrapper adds named call diagnostics", async () => {
    const source = `import { defineProof as mint } from "@gdp-ts/core";
      const proof = mint("Visible");`;
    const upstream = await lint(source, {
      ruleNames: ["no-define-proof"],
      pluginSpecifier: Bun.resolveSync(
        "@gdp-ts/core/lint/plugin",
        import.meta.dir,
      ),
    });
    expect(upstream.map(({ message }) => message)).toEqual([
      "Only modules in proofs/ may import defineProof.",
    ]);
    expect(await messages(source, ["no-define-proof"])).toEqual([
      "Only modules in proofs/ may import defineProof.",
      "Only modules in proofs/ may call defineProof.",
    ]);
  });
  test("rejects importing or calling the proof constructor outside proofs/", async () => {
    const violations = await messages(
      `import { defineProof as mint } from "@gdp-ts/core";
       import * as proofs from "@gdp-ts/core";
       const first = mint(() => true);
       const second = proofs.defineProof(() => true);`,
      ["no-define-proof"],
    );

    expect(violations).toHaveLength(3);
    expect(
      violations.every((message) =>
        message.includes("Only modules in proofs/"),
      ),
    ).toBe(true);
  });

  test("rejects exporting a prover, including an aliased constructor result", async () => {
    const violations = await messages(
      `import { defineProof as mint } from "@gdp-ts/core";
       const localProver = mint(() => true);
       export { localProver as publicProver };`,
      ["no-exported-prover"],
    );

    expect(violations).toEqual([
      "Do not export the prover. Export the proof interface and the checking function.",
    ]);
  });

  test("rejects assertions to imported proof and Named types", async () => {
    const violations = await messages(
      `import type { Proof, Named } from "@gdp-ts/core";
       import type { CanRead } from "../proofs/can-read";
       const forged = {} as Proof<string>;
       const named = {} as Named<string>;
       const fromOwner = {} as CanRead;`,
      ["no-proof-assertion"],
    );

    expect(violations).toHaveLength(3);
    expect(
      violations.every((message) =>
        message.startsWith("Do not assert a proof or Named type"),
      ),
    ).toBe(true);
  });

  test("rejects assertion and any shortcuts in strict pilot paths", async () => {
    expect(
      await lint("const value = null as any;", {
        ruleNames: ["no-type-assertion", "no-any"],
      }),
    ).toHaveLength(2);
    expect(
      await lint("const value = { kind: 'visible' } as const;", {
        ruleNames: ["no-type-assertion", "no-any"],
      }),
    ).toHaveLength(0);
  });
});
