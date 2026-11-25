// One document onto one template, end to end: read both, infer or check the
// profile, read the document's roles, numbering and cross-references, settle
// the open decisions, build the plan and have the engine apply it.
//
// The engine is the judge. When it refuses a plan for something one block
// asks for (a label it will not strip, a reference span it cannot turn into
// a field), or its report shows a paragraph that would print another number
// than the source, the plan is rebuilt without that request and applied
// again: the block keeps its typed label, the reference stays text. The
// document is never forced through; a refusal with no such way out is
// returned as it is.

import { panic, Result, TaggedError } from "better-result";

import {
  acceptDecisions,
  collectAmbiguities,
} from "@/api/lib/templates/house-style/ambiguity";
import type { AmbiguityResolver } from "@/api/lib/templates/house-style/ambiguity";
import { TemplateEngineError } from "@/api/lib/templates/house-style/folio-contract";
import type {
  TemplateEngineRefusal,
  TemplatePlan,
  TemplatePlanEngine,
  TemplatePlanReport,
} from "@/api/lib/templates/house-style/folio-contract";
import { buildLabelIndex } from "@/api/lib/templates/house-style/label-index";
import { buildTemplatePlan } from "@/api/lib/templates/house-style/plan-builder";
import type { FormattingNote } from "@/api/lib/templates/house-style/plan-builder";
import type { NumberingMode } from "@/api/lib/templates/house-style/plan-numbering";
import { detectReferences } from "@/api/lib/templates/house-style/reference-detector";
import { findTopicSuspicions } from "@/api/lib/templates/house-style/reference-suspicions";
import { proposeBlockRoles } from "@/api/lib/templates/house-style/role-proposer";
import {
  inferTemplateProfile,
  validateTemplateProfile,
} from "@/api/lib/templates/house-style/template-profile";
import type {
  TemplateProfile,
  TemplateProfileIssue,
} from "@/api/lib/templates/house-style/template-profile";

/** Applies of one document; each repair costs one. */
const ATTEMPTS_MAX = 8;

type RepairCause =
  | TemplateEngineRefusal
  /** The output would print another label than the source. */
  | "labelDiffers"
  /** A field's cached text is not what its target's label gives. */
  | "fieldTextDiffers";

type PageCounts =
  | { status: "measured"; source: number; output: number }
  /** No layout backend, or it could not lay one of the two out. */
  | { status: "notMeasured" };

/** What the engine did, read off its report. */
type FormattingOutcome = {
  attempts: number;
  /** What was taken out of the plan for the engine to accept it. */
  repairs: { cause: RepairCause; blockId: string }[];
  footnotes: { source: number; output: number };
  endnotes: { source: number; output: number };
  frozenFields: number;
  liveFields: number;
  fillerLeft: number;
  droppedComments: number;
  droppedSectionBreaks: number;
  pages: PageCounts;
};

class TemplateProfileRejectedError extends TaggedError(
  "TemplateProfileRejectedError",
)<{
  message: string;
  issues: TemplateProfileIssue[];
}> {}

type FormatOptions = {
  engine: TemplatePlanEngine;
  source: Uint8Array;
  template: Uint8Array;
  /** A confirmed profile; inferred from the template when absent. */
  profile?: TemplateProfile;
  mode: NumberingMode;
  resolveAmbiguities: AmbiguityResolver;
};

type Formatted = {
  docx: Uint8Array;
  plan: TemplatePlan;
  profile: TemplateProfile;
  note: FormattingNote;
  outcome: FormattingOutcome;
};

type Exclusions = {
  numbering: Set<string>;
  marks: Set<string>;
  targets: Set<string>;
  merges: Set<string>;
};

/** Which request of a block a refusal takes back; null when none does. */
const exclusionFor = (
  refusal: TemplateEngineRefusal,
): keyof Exclusions | null => {
  switch (refusal) {
    case "strip-label-mismatch":
      return "numbering";
    case "merge-invalid":
      return "merges";
    case "reference-span-invalid":
    case "reference-target-unplaced":
    case "highlight-span-invalid":
      return "marks";
    case "tracked-changes":
    case "unsupported-content":
    case "other":
      return null;
    default: {
      refusal satisfies never;
      return panic("Unhandled refusal");
    }
  }
};

const numberedBlockIds = ({ body }: TemplatePlan): Set<string> => {
  const ids = new Set<string>();
  for (const item of body) {
    if (item.kind !== "source") {
      continue;
    }
    // `null` takes a paragraph out of its list; absent leaves it to its
    // style. Neither is a number the plan asked for.
    if (typeof item.numbering === "object" && item.numbering !== null) {
      ids.add(item.blockId);
    }
    if (item.nested !== undefined) {
      for (const nested of item.nested) {
        if (typeof nested.numbering === "object" && nested.numbering !== null) {
          ids.add(nested.blockId);
        }
      }
    }
  }
  return ids;
};

/** Numbered paragraphs whose output label is not the source's. */
const changedLabels = (
  plan: TemplatePlan,
  { blocks }: TemplatePlanReport,
): string[] => {
  const numbered = numberedBlockIds(plan);
  return blocks
    .filter(
      ({ blockId, sourceLabel, outputLabel }) =>
        numbered.has(blockId) &&
        sourceLabel !== null &&
        sourceLabel.trim() !== (outputLabel ?? "").trim(),
    )
    .map(({ blockId }) => blockId);
};

const sum = (entries: readonly { count: number }[]): number =>
  entries.reduce((total, { count }) => total + count, 0);

/**
 * Formats `source` onto `template`. Returns the output with the plan that
 * produced it, the profile used, and the note data a formatting note is
 * written from.
 */
export const formatOntoTemplate = async ({
  engine,
  source,
  template,
  profile: confirmed,
  mode,
  resolveAmbiguities,
}: FormatOptions): Promise<
  Result<Formatted, TemplateEngineError | TemplateProfileRejectedError>
> => {
  const [analyzed, inspected, highlighted] = await Promise.all([
    engine.analyze(source),
    engine.inspect(template),
    engine.highlightColors(source),
  ]);
  if (analyzed.isErr()) {
    return Result.err(analyzed.error);
  }
  if (inspected.isErr()) {
    return Result.err(inspected.error);
  }
  if (highlighted.isErr()) {
    return Result.err(highlighted.error);
  }
  const manifest = analyzed.value;
  const profile = confirmed ?? inferTemplateProfile(inspected.value);
  const issues = validateTemplateProfile(profile, inspected.value).filter(
    ({ severity }) => severity === "error",
  );
  if (issues.length > 0) {
    return Result.err(
      new TemplateProfileRejectedError({
        message: "The template profile does not fit the template",
        issues,
      }),
    );
  }

  const index = buildLabelIndex(manifest);
  const roles = proposeBlockRoles({ manifest, index });
  const { references } = detectReferences(manifest, index);
  const suspicions = findTopicSuspicions({ manifest, index, references });
  const open = collectAmbiguities({ references, roles });
  const decisions = acceptDecisions(open, await resolveAmbiguities(open));

  const exclusions: Exclusions = {
    numbering: new Set(),
    marks: new Set(),
    targets: new Set(),
    merges: new Set(),
  };
  const repairs: FormattingOutcome["repairs"] = [];
  /** Records a repair; false when it was already made and did not help. */
  const exclude = (
    kind: keyof Exclusions,
    blockId: string,
    cause: RepairCause,
  ): boolean => {
    if (exclusions[kind].has(blockId)) {
      return false;
    }
    exclusions[kind].add(blockId);
    repairs.push({ cause, blockId });
    return true;
  };

  let attempts = 0;
  /** The apply whose report asked for no further repair. */
  let settled:
    | {
        built: ReturnType<typeof buildTemplatePlan>;
        docx: Uint8Array;
        report: TemplatePlanReport;
      }
    | undefined;
  while (settled === undefined && attempts < ATTEMPTS_MAX) {
    attempts += 1;
    const built = buildTemplatePlan({
      manifest,
      profile,
      references,
      roles,
      mode,
      index,
      decisions,
      suspicions,
      exclusions,
      sourceHighlightColors: highlighted.value,
    });
    // Each attempt is built from the engine's answer to the one before.
    const applied = await engine.apply({
      source,
      template,
      plan: built.plan,
      fillerStrings: profile.fillerStrings,
    });
    if (applied.isErr()) {
      const { reason, blockId } = applied.error;
      const kind = exclusionFor(reason);
      if (
        kind === null ||
        blockId === undefined ||
        !exclude(kind, blockId, reason)
      ) {
        return Result.err(applied.error);
      }
      continue;
    }
    const { docx, report } = applied.value;
    let repaired = false;
    // The house scheme renumbers on purpose.
    for (const blockId of mode === "keepSource"
      ? changedLabels(built.plan, report)
      : []) {
      repaired = exclude("numbering", blockId, "labelDiffers") || repaired;
    }
    for (const { targetBlockId, expectedText, predictedText } of report
      .references.results) {
      if (predictedText !== null && predictedText !== expectedText) {
        repaired =
          exclude("targets", targetBlockId, "fieldTextDiffers") || repaired;
      }
    }
    if (!repaired) {
      settled = { built, docx, report };
    }
  }
  // An output whose report still asks for a repair prints a number or a
  // field text the source does not: it is not returned.
  if (settled === undefined) {
    return Result.err(
      new TemplateEngineError({
        message: "The plan did not settle within the applies allowed",
        reason: "other",
      }),
    );
  }

  const { built, docx, report } = settled;
  let pages: PageCounts = { status: "notMeasured" };
  if (engine.layout !== undefined) {
    const [before, after] = await Promise.all([
      engine.layout(source),
      engine.layout(docx),
    ]);
    if (before.isOk() && after.isOk()) {
      pages = {
        status: "measured",
        source: before.value.pages,
        output: after.value.pages,
      };
    }
  }
  return Result.ok({
    docx,
    plan: built.plan,
    profile,
    note: built.note,
    outcome: {
      attempts,
      repairs,
      footnotes: report.footnotes,
      endnotes: report.endnotes,
      frozenFields: sum(report.leftovers.frozenFields),
      liveFields: sum(report.leftovers.fields),
      fillerLeft: sum(report.leftovers.filler),
      droppedComments: report.dropped.comments,
      droppedSectionBreaks: report.dropped.sectionBreaks,
      pages,
    },
  });
};
