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
  | {
      labelDiffers?: string[];
      fieldDiffers?: string[];
      fieldUnverified?: string[];
      labelLost?: string[];
    };

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
    const labelLost = "refuse" in answer ? [] : (answer.labelLost ?? []);
    const fieldUnverified =
      "refuse" in answer ? [] : (answer.fieldUnverified ?? []);
    const predictionOf = (targetBlockId: string, expectedText: string) => {
      if (fieldUnverified.includes(targetBlockId)) {
        return null;
      }
      return fieldDiffers.includes(targetBlockId)
        ? `${expectedText}.`
        : expectedText;
    };
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
        // A stripped typed label is printed by the list instead.
        let outputLabel = isNumbered ? (item.stripLabel ?? sourceLabel) : null;
        if (labelDiffers.includes(item.blockId)) {
          outputLabel = "9.";
        }
        const lost = labelLost.includes(item.blockId);
        return [
          {
            blockId: item.blockId,
            disposition: "placed" as const,
            sourceLabel,
            outputLabel: lost ? null : outputLabel,
            ...(item.labelAsText === true && sourceLabel !== null && !lost
              ? { labelAsText: sourceLabel.trim() }
              : {}),
          },
        ];
      }),
      references: {
        results: (plan.references ?? []).map(
          ({ blockId, targetBlockId, expectedText }) => ({
            blockId,
            targetBlockId,
            expectedText,
            predictedText: predictionOf(targetBlockId, expectedText),
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
    // Its number is automatic: out of the list, it is written as text.
    expect(numberingOf(formatted.plan, clause)).toMatchObject({
      numbering: null,
      labelAsText: true,
    });
    expect(formatted.note.items).toContainEqual({
      kind: "labelConvertedToText",
      blockId: clause,
      reason: "excluded",
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

  test("numbers a typed label on a paragraph whose own list prints nothing", async () => {
    // A heading style bound to a list for its outline only: the engine
    // reports an empty label for the paragraph and the typed one is
    // stripped onto the template's list.
    const silent = {
      ...manifest,
      blocks: manifest.blocks.map((block) =>
        block.id === article
          ? {
              ...block,
              label: "",
              numbering: { numId: 9, ilvl: 0, abstractNumId: 9 },
            }
          : block,
      ),
    };
    const engine = fakeEngine(silent, []);
    const formatted = (
      await formatOntoTemplate({
        engine,
        source: SOURCE,
        template: TEMPLATE,
        mode: "keepSource",
        resolveAmbiguities: resolveAmbiguitiesByRule,
      })
    ).unwrap();
    expect(formatted.outcome).toMatchObject({ attempts: 1, repairs: [] });
    expect(numberingOf(engine.plans.at(0), article)).toMatchObject({
      stripLabel: expect.stringContaining("II"),
    });
  });

  test("leaves a reference as text when the engine cannot say what its field shows", async () => {
    const engine = fakeEngine(manifest, [{ fieldUnverified: [article] }]);
    const formatted = (await format(engine)).unwrap();
    expect(formatted.outcome.repairs).toEqual([
      { cause: "fieldTextUnverified", blockId: article },
    ]);
    expect(engine.plans.at(0)?.references).toContainEqual(
      expect.objectContaining({ targetBlockId: article }),
    );
    expect(
      (formatted.plan.references ?? []).filter(
        ({ targetBlockId }) => targetBlockId === article,
      ),
    ).toEqual([]);
  });

  test("returns no document when the output would drop a label the source shows", async () => {
    const clause = blockIdOf(manifest, "Druhé ujednání, oddíl II:");
    // Out of its list the paragraph takes its number as text; an output
    // that shows neither is not returned.
    const engine = fakeEngine(manifest, [
      { labelLost: [clause] },
      { labelLost: [clause] },
    ]);
    const result = await format(engine);
    expect(result.isErr() && result.error).toMatchObject({
      _tag: "TemplateLabelsNotKeptError",
      phase: "applied",
      issues: [{ blockId: clause, kind: "lost" }],
    });
    expect(engine.plans).toHaveLength(2);
    expect(numberingOf(engine.plans.at(1), clause)).toMatchObject({
      numbering: null,
      labelAsText: true,
    });
  });

  test("returns the refusal when a label cannot stand as text", async () => {
    const clause = blockIdOf(manifest, "Druhé ujednání, oddíl II:");
    const engine = fakeEngine(manifest, [
      { labelDiffers: [clause] },
      { refuse: "label-not-writable", blockId: clause },
    ]);
    const result = await format(engine);
    expect(result.isErr() && result.error).toMatchObject({
      _tag: "TemplateEngineError",
      reason: "label-not-writable",
      blockId: clause,
    });
    expect(engine.plans).toHaveLength(2);
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
