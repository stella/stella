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
//
// A label the source shows is never dropped. A paragraph's list prints it,
// or it is written as text in front of the paragraph; a plan or an output
// that would do neither is refused, and so is a label that cannot stand as
// text.

import { panic, Result, TaggedError } from "better-result";

import { declareFingerprintFields } from "@stll/errors";

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
import type {
  FormattingNote,
  PlannedLabelIssue,
} from "@/api/lib/templates/house-style/plan-builder";
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
  | "fieldTextDiffers"
  /** The engine could not say what the target's label gives the field. */
  | "fieldTextUnverified";

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

/** Labels kept per error; a document rarely has more to show. */
const LABEL_ISSUES_MAX = 50;

/** The output would not show a label the source shows. Nothing is
 *  returned for such a document. */
class TemplateLabelsNotKeptError extends TaggedError(
  "TemplateLabelsNotKeptError",
)<{
  message: string;
  /** `planned`: the plan was not applied. `applied`: the engine's report
   *  showed it and no repair was left. */
  phase: "planned" | "applied";
  issues: PlannedLabelIssue[];
}> {
  static {
    declareFingerprintFields(this, ["phase"]);
  }
}

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
    // Writing the label as text was the way out already.
    case "label-not-writable":
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

/**
 * The placed paragraphs of an output that do not show the label the source
 * shows: no list prints it and it is not written as text. The house scheme
 * renumbers on purpose, so there another label counts as shown.
 */
const unkeptLabels = (
  mode: NumberingMode,
  { blocks }: TemplatePlanReport,
): PlannedLabelIssue[] => {
  const issues: PlannedLabelIssue[] = [];
  for (const block of blocks) {
    const source = (block.sourceLabel ?? "").trim();
    if (block.disposition === "omitted" || source === "") {
      continue;
    }
    const printed = (block.outputLabel ?? "").trim();
    const written = (block.labelAsText ?? "").trim();
    if (printed === "" && written === "") {
      issues.push({ blockId: block.blockId, kind: "lost" });
    } else if (
      (written !== "" && (written !== source || printed !== "")) ||
      (written === "" && mode === "keepSource" && printed !== source)
    ) {
      issues.push({ blockId: block.blockId, kind: "differs" });
    }
  }
  return issues;
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
  Result<
    Formatted,
    | TemplateEngineError
    | TemplateProfileRejectedError
    | TemplateLabelsNotKeptError
  >
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
  // The resolver works on a copy: an answer is checked against the options
  // that were offered, not against what the resolver left in its items.
  const decisions = acceptDecisions(
    open,
    await resolveAmbiguities(structuredClone(open)),
  );

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
    if (built.labelsNotKept.length > 0) {
      return Result.err(
        new TemplateLabelsNotKeptError({
          message: "The plan would not show a label the document shows",
          phase: "planned",
          issues: built.labelsNotKept.slice(0, LABEL_ISSUES_MAX),
        }),
      );
    }
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
      // A field whose text the engine cannot vouch for is no more
      // returned than one it contradicts.
      if (predictedText !== expectedText) {
        const cause =
          predictedText === null ? "fieldTextUnverified" : "fieldTextDiffers";
        repaired = exclude("targets", targetBlockId, cause) || repaired;
      }
    }
    if (repaired) {
      continue;
    }
    // Nothing is left to take back, so what the report shows is final.
    const unkept = unkeptLabels(mode, report);
    if (unkept.length > 0) {
      return Result.err(
        new TemplateLabelsNotKeptError({
          message: "The output would not show a label the document shows",
          phase: "applied",
          issues: unkept.slice(0, LABEL_ISSUES_MAX),
        }),
      );
    }
    settled = { built, docx, report };
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
