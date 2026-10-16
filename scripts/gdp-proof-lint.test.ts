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
  proofOwner?: boolean;
};
const lint = async (
  source: string,
  {
    ruleNames,
    proofOwner = false,
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
        overrides: proofOwner
          ? [
              {
                files: ["**/input.ts"],
                rules: { "gdp-ts/no-define-proof": "off" },
              },
            ]
          : [],
        rules: Object.fromEntries(
          ruleNames.map((rule) => [`gdp-ts/${rule}`, "error"]),
        ),
      })};`,
    );
    const child = Bun.spawn(
      ["bun", "--bun", "oxlint", "-c", config, "--format", "json", input],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        stdin: "ignore",
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
  test("blocks matter proof casts and object construction outside the predicate owner", async () => {
    const ruleNames = ["no-matter-proof-forgery"];
    const ownerImport = `import type { MatterReadable as Readable, MatterWritable } from "@/api/lib/workspaces/matter-access-proof";`;
    expect(
      await messages(
        `${ownerImport} const forged = {} as Readable; const writable: MatterWritable = {}; const checked = {} satisfies Readable;`,
        ruleNames,
      ),
    ).toEqual([
      "Only matter-access-proof.ts may cast or construct MatterReadable/MatterWritable.",
      "Only matter-access-proof.ts may cast or construct MatterReadable/MatterWritable.",
      "Only matter-access-proof.ts may cast or construct MatterReadable/MatterWritable.",
    ]);
    expect(
      await messages(
        `import * as matterProof from "@/api/lib/workspaces/matter-access-proof"; type Readable = matterProof.MatterReadable; import type { MatterWritable as Writable } from "@/api/lib/workspaces/matter-access-proof"; const value: Writable = {} as Writable;`,
        ruleNames,
      ),
    ).toEqual([
      "Only matter-access-proof.ts may cast or construct MatterReadable/MatterWritable.",
    ]);
    expect(
      await messages(
        `import type { Proof } from "@gdp-ts/core"; type MatterProof = Proof<"MatterReadable", []>; const forged = {} as MatterProof;`,
        ruleNames,
      ),
    ).toEqual([
      "Only matter-access-proof.ts may cast or construct MatterReadable/MatterWritable.",
    ]);
    expect(
      await messages(
        `${ownerImport} declare const existing: Readable; const forwarded: Readable = existing;`,
        ruleNames,
      ),
    ).toEqual([]);
  });

  test("resolves matter proof aliases before rejecting construction", async () => {
    const violations = await messages(
      `import type { Proof as Evidence } from "@gdp-ts/core";
       const forged: Forward = {};
       type Forward = Later;
       type Later = Evidence<"MatterWritable", []>;
       const inline = {} as import("@/api/lib/workspaces/matter-access-proof").MatterReadable;`,
      ["no-matter-proof-forgery"],
    );
    expect(violations).toEqual([
      "Only matter-access-proof.ts may cast or construct MatterReadable/MatterWritable.",
      "Only matter-access-proof.ts may cast or construct MatterReadable/MatterWritable.",
    ]);
  });

  test("prevents existing predicates from minting matter-specific kinds", async () => {
    const message =
      "MatterReadable and MatterWritable transaction proofs may only be minted by matter-access-proof.ts.";
    expect(
      await messages(
        `import { withCheckedTransaction as mint } from "@/api/lib/proofs/checked-transaction"; const alias = mint; alias({ kind: "MatterReadable" });`,
        ["no-matter-proof-kind-outside-owner"],
      ),
    ).toEqual([message]);
    expect(
      await messages(
        `import { withCheckedTransaction } from "@/api/lib/proofs/checked-transaction"; const kind = "MatterWritable"; const first = { kind }; const options = first; withCheckedTransaction(options);`,
        ["no-matter-proof-kind-outside-owner"],
      ),
    ).toEqual([message]);
    expect(
      await messages(
        `import * as checked from "@/api/lib/proofs/checked-transaction"; checked.withCheckedTransaction({ kind: "MatterWritable" });`,
        ["no-matter-proof-kind-outside-owner"],
      ),
    ).toEqual([message]);
    expect(
      await messages(
        `import { withCheckedTransaction } from "@/api/lib/proofs/checked-transaction"; withCheckedTransaction({ kind: "SignalVisible" });`,
        ["no-matter-proof-kind-outside-owner"],
      ),
    ).toEqual([]);
    expect(
      await messages(
        `import { withCheckedTransaction } from "@/api/lib/proofs/checked-transaction"; const options = loadOptions(); withCheckedTransaction(options);`,
        ["no-matter-proof-kind-outside-owner"],
      ),
    ).toEqual([message]);
  });

  test("only an inline options literal with a plain safe kind passes", async () => {
    const message =
      "MatterReadable and MatterWritable transaction proofs may only be minted by matter-access-proof.ts.";
    const mint = `import { withCheckedTransaction } from "@/api/lib/proofs/checked-transaction";`;
    // Each of these can end with a matter kind although a safe kind is written.
    for (const options of [
      `{ kind: "SignalVisible", ...overrides }`,
      `{ kind: "SignalVisible", kind: "MatterWritable" }`,
      `{ kind: "SignalVisible", [key]: "MatterWritable" }`,
      `{ kind: "SignalVisible", [\`kind\`]: "MatterWritable" }`,
    ]) {
      expect(
        await messages(`${mint} withCheckedTransaction(${options});`, [
          "no-matter-proof-kind-outside-owner",
        ]),
      ).toEqual([message]);
    }
    expect(
      await messages(
        `${mint} let kind = "SignalVisible"; kind = "MatterWritable"; withCheckedTransaction({ kind });`,
        ["no-matter-proof-kind-outside-owner"],
      ),
    ).toEqual([message]);
    expect(
      await messages(
        `${mint} const options = { kind: "SignalVisible" }; options.kind = "MatterWritable"; withCheckedTransaction(options);`,
        ["no-matter-proof-kind-outside-owner"],
      ),
    ).toEqual([message]);
    expect(
      await messages(
        `import * as checked from "@/api/lib/proofs/checked-transaction"; const { withCheckedTransaction: mint } = checked; const alias = checked.withCheckedTransaction; mint({ kind: "MatterReadable" }); alias({ kind: "MatterWritable" });`,
        ["no-matter-proof-kind-outside-owner"],
      ),
    ).toEqual([message, message]);
    expect(
      await messages(
        `const checked = await import("@/api/lib/proofs/checked-transaction");`,
        ["no-matter-proof-kind-outside-owner"],
      ),
    ).toEqual([message]);
    // The shape every registered predicate uses stays admitted.
    expect(
      await messages(
        `${mint} const kind = "SignalVisibleTo"; withCheckedTransaction({ kind, tx, organizationId, check: async (id) => id, "entityId": entity });`,
        ["no-matter-proof-kind-outside-owner"],
      ),
    ).toEqual([]);
  });

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

  const extractions = [
    { source: "const mint = gdp.defineProof;", expectedCount: 1 },
    { source: 'const mint = gdp["defineProof"];', expectedCount: 1 },
    { source: "const { defineProof: mint } = gdp;", expectedCount: 1 },
    { source: 'const { "defineProof": mint } = gdp;', expectedCount: 1 },
    {
      source: "const { defineProof: mint = fallback } = gdp;",
      expectedCount: 1,
    },
    { source: "const { defineProof } = gdp;", expectedCount: 1 },
    { source: 'const { ["defineProof"]: mint } = gdp;', expectedCount: 1 },
    { source: "let mint; mint = gdp.defineProof;", expectedCount: 1 },
    { source: "let mint; ({ defineProof: mint } = gdp);", expectedCount: 1 },
    {
      source: "const namespace = gdp; const mint = namespace.defineProof;",
      expectedCount: 1,
    },
    {
      source:
        "const first = gdp.defineProof; const second = first; let third; third = second;",
      expectedCount: 3,
    },
    {
      source: "let first, second; first = second = gdp.defineProof;",
      expectedCount: 2,
    },
    {
      source:
        "let namespace, secondNamespace; namespace = secondNamespace = gdp; const mint = namespace.defineProof;",
      expectedCount: 1,
    },
    {
      source:
        "let namespace; namespace = gdp; const { defineProof: first } = namespace; let second; second = first;",
      expectedCount: 2,
    },
  ];
  for (const { source: extraction, expectedCount } of extractions) {
    test(`confines constructor extraction: ${extraction}`, async () => {
      const source = `import * as gdp from "@gdp-ts/core"; ${extraction}`;
      const violations = await lint(source, { ruleNames: ["no-define-proof"] });
      expect(violations).toHaveLength(expectedCount);
      expect(
        violations.every(
          ({ message }) =>
            message === "Only modules in proofs/ may extract defineProof.",
        ),
      ).toBe(true);
      expect(
        await lint(source, {
          ruleNames: ["no-define-proof"],
          proofOwner: true,
        }),
      ).toEqual([]);
    });
  }
  test("tracks constructor calls through reassigned extraction chains", async () => {
    expect(
      await messages(
        `import * as gdp from "@gdp-ts/core";
      const first = gdp.defineProof; let second; second = first; second("Visible");`,
        ["no-define-proof"],
      ),
    ).toEqual([
      "Only modules in proofs/ may extract defineProof.",
      "Only modules in proofs/ may extract defineProof.",
      "Only modules in proofs/ may call defineProof.",
    ]);
  });
  test("accepts unrelated namespace members and type-only namespace imports", async () => {
    expect(
      await messages(
        `import * as gdp from "@gdp-ts/core";
      const helper = gdp.name; const { name } = gdp; let alias; alias = helper;`,
        ["no-define-proof"],
      ),
    ).toEqual([]);
    expect(
      await messages(
        `import type * as gdp from "@gdp-ts/core";
      type Constructor = typeof gdp.defineProof;`,
        ["no-define-proof"],
      ),
    ).toEqual([]);
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
