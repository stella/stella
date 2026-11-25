import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { resolveAmbiguitiesByRule } from "@/api/lib/templates/house-style/ambiguity";
import { TemplateEngineError } from "@/api/lib/templates/house-style/folio-contract";
import type {
  DocxBlockManifest,
  TemplateEngineRefusal,
  TemplatePlan,
  TemplatePlanEngine,
  TemplatePlanReport,
} from "@/api/lib/templates/house-style/folio-contract";
import { formatOntoTemplate } from "@/api/lib/templates/house-style/format-onto-template";
import {
  blockIdOf,
  czechContract,
} from "@/api/lib/templates/house-style/manifest.test-helpers";
import { inferTemplateProfile } from "@/api/lib/templates/house-style/template-profile";
import { contractTemplate } from "@/api/lib/templates/house-style/template.test-helpers";

const SOURCE = new Uint8Array([1]);
const TEMPLATE = new Uint8Array([2]);
const OUTPUT = new Uint8Array([3]);

type Answer =
  | { refuse: TemplateEngineRefusal; blockId?: string }
  /** Blocks whose output label differs, and targets whose field text does. */
  | { labelDiffers?: string[]; fieldDiffers?: string[] };

type FakeEngine = TemplatePlanEngine & { plans: TemplatePlan[] };

/** An engine that answers each apply from a script and reports what the
 *  plan asked for, as the real one reports what it wrote. */
const fakeEngine = (
  manifest: DocxBlockManifest,
  script: Answer[],
  pages?: { source: number; output: number },
): FakeEngine => {
  const plans: TemplatePlan[] = [];
  const reportOf = (plan: TemplatePlan, answer: Answer): TemplatePlanReport => {
    const labelDiffers = "refuse" in answer ? [] : (answer.labelDiffers ?? []);
    const fieldDiffers = "refuse" in answer ? [] : (answer.fieldDiffers ?? []);
    const labels = new Map(manifest.blocks.map(({ id, label }) => [id, label]));
    return {
      ok: true,
      blocks: plan.body.flatMap((item) => {
        if (item.kind !== "source") {
          return [];
        }
        const sourceLabel = labels.get(item.blockId) ?? item.stripLabel ?? null;
        const isNumbered =
          typeof item.numbering === "object" && item.numbering !== null;
        let outputLabel = isNumbered ? sourceLabel : null;
        if (labelDiffers.includes(item.blockId)) {
          outputLabel = "9.";
        }
        return [
          {
            blockId: item.blockId,
            disposition: "placed" as const,
            sourceLabel,
            outputLabel,
          },
        ];
      }),
      references: {
        results: (plan.references ?? []).map(
          ({ blockId, targetBlockId, expectedText }) => ({
            blockId,
            targetBlockId,
            expectedText,
            predictedText: fieldDiffers.includes(targetBlockId)
              ? `${expectedText}.`
              : expectedText,
          }),
        ),
      },
      footnotes: { source: 1, output: 1 },
      endnotes: { source: 0, output: 0 },
      leftovers: {
        fields: [{ part: "word/footer1.xml", kind: "PAGE", count: 1 }],
        frozenFields: [{ part: "word/footer2.xml", kind: "TIME", count: 1 }],
        filler: [],
      },
      dropped: {
        comments: 2,
        sourceFields: [],
        internalHyperlinks: 0,
        sectionBreaks: 1,
      },
    };
  };
  return {
    plans,
    analyze: async () => await Promise.resolve(Result.ok(manifest)),
    inspect: async () => await Promise.resolve(Result.ok(contractTemplate())),
    highlightColors: async () => await Promise.resolve(Result.ok(["cyan"])),
    apply: async ({ plan }) => {
      const answer = script[plans.length] ?? {};
      plans.push(plan);
      return await Promise.resolve(
        "refuse" in answer
          ? Result.err(
              new TemplateEngineError({
                message: "refused",
                reason: answer.refuse,
                ...(answer.blockId === undefined
                  ? {}
                  : { blockId: answer.blockId }),
              }),
            )
          : Result.ok({ docx: OUTPUT, report: reportOf(plan, answer) }),
      );
    },
    ...(pages === undefined
      ? {}
      : {
          layout: async (docx: Uint8Array) =>
            await Promise.resolve(
              Result.ok({
                pages: docx === SOURCE ? pages.source : pages.output,
              }),
            ),
        }),
  };
};

const format = async (engine: TemplatePlanEngine) =>
  await formatOntoTemplate({
    engine,
    source: SOURCE,
    template: TEMPLATE,
    mode: "keepSource",
    resolveAmbiguities: resolveAmbiguitiesByRule,
  });

const numberingOf = (plan: TemplatePlan | undefined, blockId: string) =>
  plan?.body.find((item) => item.kind === "source" && item.blockId === blockId);

describe("formatOntoTemplate", () => {
  const manifest = czechContract(
    "Viz čl. II odst. 2 této smlouvy a čl. XX této smlouvy.",
  );
  const article = blockIdOf(manifest, "Článek II.");
  const citing = blockIdOf(manifest, "Viz čl. II");

  test("applies the plan once when the engine takes it", async () => {
    const engine = fakeEngine(manifest, [], { source: 4, output: 5 });
    const formatted = (await format(engine)).unwrap();
    expect(formatted.docx).toBe(OUTPUT);
    expect(engine.plans.at(0)).toBe(formatted.plan);
    expect(formatted.outcome).toEqual({
      attempts: 1,
      repairs: [],
      footnotes: { source: 1, output: 1 },
      endnotes: { source: 0, output: 0 },
      frozenFields: 1,
      liveFields: 1,
      fillerLeft: 0,
      droppedComments: 2,
      droppedSectionBreaks: 1,
      pages: { status: "measured", source: 4, output: 5 },
    });
    // The unresolved reference is marked in a colour the source does not use.
    expect(formatted.plan.highlights).toEqual([
      expect.objectContaining({ blockId: citing, color: "magenta" }),
    ]);
  });

  test("takes back what the engine refuses of one block and applies again", async () => {
    const engine = fakeEngine(manifest, [
      { refuse: "strip-label-mismatch", blockId: article },
      { refuse: "reference-span-invalid", blockId: citing },
    ]);
    const formatted = (await format(engine)).unwrap();
    expect(formatted.outcome.attempts).toBe(3);
    expect(formatted.outcome.repairs).toEqual([
      { cause: "strip-label-mismatch", blockId: article },
      { cause: "reference-span-invalid", blockId: citing },
    ]);
    expect(formatted.outcome.pages).toEqual({ status: "notMeasured" });
    expect(numberingOf(engine.plans.at(0), article)).toMatchObject({
      stripLabel: "Článek II.",
    });
    // The label stays typed text and the citing paragraph plain.
    expect(numberingOf(formatted.plan, article)).toMatchObject({
      numbering: null,
    });
    expect(numberingOf(formatted.plan, article)).not.toHaveProperty(
      "stripLabel",
    );
    expect(
      [
        ...(formatted.plan.references ?? []),
        ...(formatted.plan.highlights ?? []),
      ].filter(({ blockId }) => blockId === citing),
    ).toEqual([]);
  });

  test("takes a paragraph out of its list when the output would renumber it", async () => {
    const clause = blockIdOf(manifest, "Druhé ujednání, oddíl II:");
    const engine = fakeEngine(manifest, [
      { labelDiffers: [clause], fieldDiffers: [article] },
    ]);
    const formatted = (await format(engine)).unwrap();
    expect(formatted.outcome.attempts).toBe(2);
    expect(formatted.outcome.repairs).toEqual([
      { cause: "labelDiffers", blockId: clause },
      { cause: "fieldTextDiffers", blockId: article },
    ]);
    expect(numberingOf(formatted.plan, clause)).toMatchObject({
      numbering: null,
    });
    // Nothing links to the paragraph any more, nor to the article whose
    // field would show another text.
    expect(
      (formatted.plan.references ?? []).filter(
        ({ targetBlockId }) =>
          targetBlockId === clause || targetBlockId === article,
      ),
    ).toEqual([]);
  });

  test("returns no document when the plan does not settle within the applies allowed", async () => {
    // Every apply shows another paragraph renumbered.
    const clauses = manifest.blocks
      .filter(({ label }) => label === "1.")
      .map(({ id }) => id);
    const engine = fakeEngine(
      manifest,
      clauses.slice(0, 8).map((clause) => ({ labelDiffers: [clause] })),
    );
    const result = await format(engine);
    expect(engine.plans).toHaveLength(8);
    expect(result.isErr() && result.error).toMatchObject({
      _tag: "TemplateEngineError",
      reason: "other",
    });
  });

  test("returns a refusal that no change to the plan answers", async () => {
    const tracked = await format(
      fakeEngine(manifest, [{ refuse: "tracked-changes" }]),
    );
    expect(tracked.isErr() && tracked.error).toMatchObject({
      _tag: "TemplateEngineError",
      reason: "tracked-changes",
    });
    // The same refusal twice: the repair did not help.
    const stuck = fakeEngine(manifest, [
      { refuse: "merge-invalid", blockId: article },
      { refuse: "merge-invalid", blockId: article },
    ]);
    expect((await format(stuck)).isErr()).toBe(true);
    expect(stuck.plans).toHaveLength(2);
  });

  test("refuses a confirmed profile that does not fit the template", async () => {
    const engine = fakeEngine(manifest, []);
    const profile = {
      ...inferTemplateProfile(contractTemplate()),
      templateSha256: "b".repeat(64),
    };
    const result = await formatOntoTemplate({
      engine,
      source: SOURCE,
      template: TEMPLATE,
      profile,
      mode: "keepSource",
      resolveAmbiguities: resolveAmbiguitiesByRule,
    });
    expect(result.isErr() && result.error).toMatchObject({
      _tag: "TemplateProfileRejectedError",
      issues: [{ severity: "error", code: "templateMismatch" }],
    });
    expect(engine.plans).toEqual([]);
  });
});
