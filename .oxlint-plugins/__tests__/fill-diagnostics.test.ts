import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { RECORD_KINDS } from "../fill-diagnostics.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

setDefaultTimeout(20_000);

const CONSUMER = "apps/api/src/handlers/templates/new-consumer.ts";
const OWNER = "apps/api/src/lib/templates/template-fill-completion.ts";
const SERVICE = "apps/api/src/lib/templates/template-fill-service.ts";

const lint =
  (rule: string) =>
  async (lines: readonly string[], sourcePath = CONSUMER) =>
    await lintSingleRule(rule, [...lines, ""].join("\n"), {
      plugin: "fill-diagnostics",
      sourcePath,
    });

const consumerReadsDecision = lint("fill-consumer-reads-decision");
const rawDecision = lint("no-raw-diagnostic-decision");
const statusLiteral = lint("fill-status-literal-in-owner");
const channel = lint("no-diagnostic-channel-outside-record");
const fillRow = lint("fill-row-through-recorder");

describe("diagnostic kinds", () => {
  test("the rules know exactly the record's kinds", () => {
    const owner = readFileSync(path.join(REPO_ROOT, OWNER), "utf-8");
    const list =
      /FILL_DIAGNOSTIC_KINDS = everyKind\(\[(?<kinds>[^\]]*)\]\)/u.exec(owner)
        ?.groups?.kinds ?? "";
    const kinds = [...list.matchAll(/"(?<kind>[A-Za-z]+)"/gu)].map(
      (match) => match.groups?.kind ?? "",
    );
    expect(kinds.length).toBeGreaterThan(0);
    expect([...RECORD_KINDS].toSorted()).toEqual(kinds.toSorted());
  });
});

const SERVICE_IMPORT =
  'import { fillStoredTemplateDocx } from "@/api/lib/templates/template-fill-service";';

describe.serial("fill-consumer-reads-decision", () => {
  test("reports a fill whose module never reads the completion decision", async () => {
    expect(
      await consumerReadsDecision([
        SERVICE_IMPORT,
        "export const run = async () => await fillStoredTemplateDocx({});",
      ]),
    ).toEqual([1]);
  });

  test("accepts a fill whose module reads the decision", async () => {
    for (const [reader, owner] of [
      ["decideTemplateFillCompletion", "template-fill-completion"],
      ["templateFillStatus", "template-fill-completion"],
      // Records the owner's status as the fill row's.
      ["recordTemplateFill", "record-use"],
    ] as const) {
      expect(
        await consumerReadsDecision([
          SERVICE_IMPORT,
          `import { ${reader} } from "@/api/lib/templates/${owner}";`,
          "export const run = async () => {",
          "  const filled = await fillStoredTemplateDocx({});",
          `  return ${reader}({ mode: "allow_partial", diagnostics: filled });`,
          "};",
        ]),
      ).toEqual([]);
    }
  });

  test("ignores type imports and non-fill exports of the service", async () => {
    expect(
      await consumerReadsDecision([
        'import type { fillStoredTemplate } from "@/api/lib/templates/template-fill-service";',
        'import { loadStoredTemplateSource } from "@/api/lib/templates/template-fill-service";',
        "export type T = typeof fillStoredTemplate;",
        "export const load = loadStoredTemplateSource;",
      ]),
    ).toEqual([]);
  });

  test("keeps the raw producers inside the fill service", async () => {
    const source = [
      'import { fillTemplate } from "../docx/patch-template";',
      'import { resolveAiConditions } from "@/api/lib/docx/resolve-ai-conditions";',
      "export const producers = [fillTemplate, resolveAiConditions];",
    ];
    expect(await consumerReadsDecision(source)).toEqual([1, 2]);
    expect(await consumerReadsDecision(source, SERVICE)).toEqual([]);
  });
});

describe.serial("no-raw-diagnostic-decision", () => {
  test("reports a kind compared, negated or tested into a verdict", async () => {
    expect(
      await rawDecision([
        "declare const filled: { aiFieldErrors: string[]; unmatchedPlaceholders: string[]; undecidedConditions: string[] };",
        "declare let status: string;",
        "export const complete = filled.aiFieldErrors.length === 0;",
        "export const empty = !filled.unmatchedPlaceholders.length;",
        "if (filled.undecidedConditions.some(Boolean)) {",
        '  status = "partial";',
        "}",
        "const { aiFieldErrors } = filled;",
        'export const verdict = aiFieldErrors.length > 0 ? "partial" : "success";',
      ]),
    ).toEqual([3, 4, 5, 9]);
  });

  test("treats an unrestored anonymization placeholder as a kind", async () => {
    expect(
      await rawDecision([
        "declare const d: { unrestoredFields: string[] };",
        "declare const graded: { completionStatus: string };",
        "export const restored = d.unrestoredFields.length === 0;",
        "export const out = d.unrestoredFields.length === 0 ? graded : { ...graded, unrestoredFields: d.unrestoredFields };",
      ]),
    ).toEqual([3]);
  });

  test("accepts passing a base on only when it is the one the other branch extends", async () => {
    expect(
      await rawDecision([
        "declare const d: { aiFieldErrors: string[] };",
        "declare const base: object;",
        "declare const other: object;",
        "export const same = d.aiFieldErrors.length === 0 ? base : { ...base, aiFieldErrors: d.aiFieldErrors };",
        "export const differs = d.aiFieldErrors.length === 0 ? base : { ...other, aiFieldErrors: d.aiFieldErrors };",
      ]),
    ).toEqual([5]);
  });

  test("reports a test on one kind that guards another", async () => {
    expect(
      await rawDecision([
        "declare const filled: { aiFieldErrors: string[]; unmatchedPlaceholders: string[] };",
        "export const shown = filled.aiFieldErrors.length > 0 ? filled.unmatchedPlaceholders : null;",
      ]),
    ).toEqual([2]);
  });

  test("accepts a test that only presents the same kind", async () => {
    expect(
      await rawDecision([
        "declare const filled: { structureErrors: string[]; aiFieldErrors: string[] };",
        "declare const warn: (list: readonly string[]) => void;",
        "export const column = filled.structureErrors.length > 0 ? filled.structureErrors : null;",
        "const { aiFieldErrors } = filled;",
        "export const receipt = { ...(aiFieldErrors.length === 0 ? {} : { aiFieldErrors }) };",
        "if (filled.aiFieldErrors.length > 0) {",
        "  warn(filled.aiFieldErrors);",
        "}",
        "export const count = filled.aiFieldErrors.length;",
        "export const paths = filled.aiFieldErrors.map((error) => error);",
      ]),
    ).toEqual([]);
  });

  test("leaves the owner alone", async () => {
    expect(
      await rawDecision(
        [
          "declare const d: { aiFieldErrors: string[] };",
          "export const complete = d.aiFieldErrors.length === 0;",
        ],
        OWNER,
      ),
    ).toEqual([]);
  });
});

describe.serial("fill-status-literal-in-owner", () => {
  const writes = [
    'import type { FillDiagnostics } from "@/api/lib/templates/template-fill-completion";',
    "declare const d: FillDiagnostics;",
    "declare const decision: { type: string };",
    'export const row = { status: "success" };',
    'export const out = { completionStatus: decision.type === "complete" ? ("complete" as const) : "partial" };',
    "export const fillStatus = (): string => {",
    '  return "partial";',
    "};",
  ];

  test("reports status literals written in a module that reads fills", async () => {
    expect(await statusLiteral(writes)).toEqual([4, 5, 5, 7]);
  });

  test("ignores the same words in modules that never read a fill", async () => {
    expect(await statusLiteral(writes.slice(1))).toEqual([]);
  });

  test("accepts comparisons with the decision and non-status slots", async () => {
    expect(
      await statusLiteral([
        'import type { FillDiagnostics } from "@/api/lib/templates/template-fill-completion";',
        "declare const decision: { type: string };",
        'export const done = decision.type === "complete";',
        'export const toast = { title: "success", kind: "partial" };',
      ]),
    ).toEqual([]);
  });

  test("leaves the owner alone", async () => {
    expect(await statusLiteral(writes, OWNER)).toEqual([]);
  });

  const READERS =
    'import { decideTemplateFillCompletion, templateFillStatus } from "@/api/lib/templates/template-fill-completion";';

  test("accepts a conditional restating the owner's reading one to one", async () => {
    expect(
      await statusLiteral([
        READERS,
        "export const gate = async () => {",
        "  const completion = decideTemplateFillCompletion({});",
        "  const fillStatus = await templateFillStatus({});",
        "  return [",
        '    { completionStatus: completion.type === "complete" ? ("complete" as const) : "partial" },',
        '    completion.type === "complete" ? { completionStatus: "complete" } : { completionStatus: "partial", shortfall: [] },',
        '    { completionStatus: fillStatus === "success" ? "complete" : "partial" },',
        '    { completionStatus: fillStatus !== "success" ? "partial" : "complete" },',
        '    { completionStatus: "complete" === completion.type ? "complete" : "partial" },',
        "  ];",
        "};",
      ]),
    ).toEqual([]);
  });

  test("reports a restatement that disagrees with the reading or has no owner reading", async () => {
    expect(
      await statusLiteral([
        READERS,
        "declare const elsewhere: { type: string };",
        "export const gate = () => {",
        "  const completion = decideTemplateFillCompletion({});",
        "  const fillStatus = templateFillStatus({});",
        "  return [",
        // Swapped branches.
        '    { completionStatus: completion.type === "complete" ? "partial" : "complete" },',
        // Not `partial` is `complete` or `rejected_partial`.
        '    { completionStatus: completion.type === "partial" ? "partial" : "complete" },',
        // The status reading has no `type`.
        '    { completionStatus: fillStatus.type === "complete" ? "complete" : "partial" },',
        // Not a reading of the owner.
        '    { completionStatus: elsewhere.type === "complete" ? "complete" : "partial" },',
        "  ];",
        "};",
        // A reading bound in another function is not this one.
        "export const other = (completion: { type: string }) => ({",
        '  completionStatus: completion.type === "complete" ? "complete" : "partial",',
        "});",
      ]),
    ).toEqual([7, 7, 8, 8, 9, 9, 10, 10, 14, 14]);
  });

  test("budgets the ledgered sites and nothing beyond them", async () => {
    const preview = [
      'import { fillTemplateDocx } from "@/api/lib/templates/template-fill-service";',
      "export const preview = fillTemplateDocx;",
    ];
    const ledgered = "apps/api/src/lib/templates/fill-preview-logic.ts";
    // Within its budget: one fill entry point without the decision.
    expect(await consumerReadsDecision(preview, ledgered)).toEqual([]);
    const extra = [
      'import { fillTemplateDocx, fillStoredTemplate } from "@/api/lib/templates/template-fill-service";',
      "export const preview = [fillTemplateDocx, fillStoredTemplate];",
    ];
    expect(await consumerReadsDecision(extra, ledgered)).toEqual([1]);
  });

  test("reports a budget the code no longer reaches", async () => {
    expect(
      await consumerReadsDecision(
        ["export const preview = null;"],
        "apps/api/src/lib/templates/fill-preview-logic.ts",
      ),
    ).toEqual([1]);
  });
});

describe.serial("no-diagnostic-channel-outside-record", () => {
  test("reports a new channel key beside the record", async () => {
    expect(
      await channel([
        "export type Produced = { fooWarnings: string[]; structureErrors: string[] };",
        "export const produced = { barErrors: [], aiFieldErrors: [] };",
        "export class Holder { bazFailures: string[] = []; }",
      ]),
    ).toEqual([1, 2, 3]);
  });

  test("accepts the record's kinds, destructuring and plain words", async () => {
    expect(
      await channel([
        "declare const r: Record<string, string[]>;",
        "const { fooWarnings } = r;",
        "export const ok = { clauseWarnings: [], errors: [], warnings: fooWarnings };",
      ]),
    ).toEqual([]);
  });
});

describe.serial("fill-row-through-recorder", () => {
  const source = [
    'import { templateFills as fills } from "@/api/db/schema";',
    "declare const tx: { insert: (table: unknown) => unknown };",
    "declare const templateFills: unknown;",
    "export const a = tx.insert(fills);",
  ];

  test("reports a fill row written outside the recorder", async () => {
    expect(await fillRow(source)).toEqual([4]);
  });

  test("leaves the recorder and unrelated locals alone", async () => {
    expect(
      await fillRow(source, "apps/api/src/lib/templates/record-use.ts"),
    ).toEqual([]);
    expect(
      await fillRow([
        "declare const tx: { insert: (table: unknown) => unknown };",
        "declare const templateFills: unknown;",
        "export const a = tx.insert(templateFills);",
      ]),
    ).toEqual([]);
  });
});
