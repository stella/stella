import * as v from "valibot";

import type { TemplateFillStatus } from "@/api/db/schema";
import type { ClauseDirectiveWarning } from "@/api/lib/clauses/clause-directives";
import type { ResolvedAiCondition } from "@/api/lib/docx/resolve-ai-conditions";
import type { AiFieldError } from "@/api/lib/docx/resolve-ai-fields";
import type { TemplateStructureError } from "@/api/lib/docx/types";
import type {
  FilledDocumentMember,
  FilledDocx,
} from "@/api/lib/templates/template-fill-service";

export const TEMPLATE_FILL_COMPLETION_MODES = [
  "require_complete",
  "allow_partial",
] as const;

export type TemplateFillCompletionMode =
  (typeof TEMPLATE_FILL_COMPLETION_MODES)[number];

const DEFAULT_TEMPLATE_FILL_COMPLETION_MODE =
  "require_complete" satisfies TemplateFillCompletionMode;

/**
 * The `completion_mode` argument every template-rendering tool accepts. One
 * declaration so a transient fill and a persisting fill cannot drift into
 * different defaults: an omitted mode is strict on both.
 */
export const templateFillCompletionModeSchema = v.optional(
  v.pipe(
    v.picklist(TEMPLATE_FILL_COMPLETION_MODES),
    v.description(
      "Require a complete fill by default (every placeholder filled, every AI-drafted field written, every AI-decided condition decided); use allow_partial only for an intentionally incomplete document.",
    ),
  ),
  DEFAULT_TEMPLATE_FILL_COMPLETION_MODE,
);

/** An AI-decided condition no tier settled. Its field stays unset, so the
 *  renderer reads it as false: a `{% if %}` block is dropped and a negated one
 *  kept, neither of which anyone decided. */
export type UndecidedAiCondition = Extract<
  ResolvedAiCondition,
  { state: "undecided" }
>;

/**
 * Everything a fill reports about where the rendered document differs from
 * what the template and the caller's values asked for. This record is the
 * only input of {@link decideTemplateFillCompletion}, and every kind in it is
 * graded in {@link FILL_DIAGNOSTIC_GRADES}, so a new kind cannot reach the
 * decision ungraded.
 */
export type FillDiagnostics = {
  /** `{{ placeholders }}` the renderer found no value for. */
  readonly unmatchedPlaceholders: readonly string[];
  /** AI-drafted fields whose draft failed; the field is left unfilled. */
  readonly aiFieldErrors: readonly AiFieldError[];
  /** AI-decided conditions nothing settled; their blocks were not decided. */
  readonly undecidedConditions: readonly UndecidedAiCondition[];
  /** Stored clauses inserted as written because their directives no longer
   *  validate: their markers stay literal and their conditions unapplied. */
  readonly clauseWarnings: readonly ClauseDirectiveWarning[];
  /** Directives the renderer could not apply. */
  readonly structureErrors: readonly TemplateStructureError[];
  /** Supplied values the template never reads. */
  readonly unusedValues: readonly string[];
  /** Field paths whose value reached the document still holding an
   *  anonymization placeholder the turn's boundary could not restore: the
   *  document carries the placeholder, not the real value. Only a fill behind
   *  an anonymizing boundary (the chat tool) can have any. */
  readonly unrestoredFields: readonly string[];
};

export type FillDiagnosticKind = keyof FillDiagnostics;

/** `blocking`: the document is missing or misstates content, so the fill is
 *  not complete. `informational`: the document is as asked. */
type FillDiagnosticSeverity = "blocking" | "informational";

export type FillDiagnosticGrades = {
  readonly [K in FillDiagnosticKind]: (
    entry: FillDiagnostics[K][number],
  ) => FillDiagnosticSeverity;
};

/** One grade per clause warning code, so a new code cannot land ungraded. */
const CLAUSE_WARNING_SEVERITY = {
  // Deliberately informational: a stored clause whose directives no longer
  // validate still fills as before (inserted as written) with a typed
  // warning, and is never refused. Historical content stays usable; only new
  // publication validates directives. The warning is still reported on every
  // surface and recorded in the diagnostics.
  CLAUSE_LEGACY_DIRECTIVES: "informational",
  CLAUSE_OVERRIDE_NOT_RENDERED: "informational",
} as const satisfies Record<
  ClauseDirectiveWarning["code"],
  FillDiagnosticSeverity
>;

/** How each diagnostic kind weighs on completion. Total over
 *  {@link FillDiagnosticKind}: adding a kind without a grade fails typecheck. */
export const FILL_DIAGNOSTIC_GRADES = {
  unmatchedPlaceholders: () => "blocking",
  aiFieldErrors: () => "blocking",
  undecidedConditions: () => "blocking",
  clauseWarnings: (warning) => CLAUSE_WARNING_SEVERITY[warning.code],
  structureErrors: () => "blocking",
  unusedValues: () => "informational",
  unrestoredFields: () => "blocking",
} as const satisfies FillDiagnosticGrades;

/** Accepts a list of kinds only when it names every kind. */
const everyKind = <const TKinds extends readonly FillDiagnosticKind[]>(
  kinds: TKinds &
    ([Exclude<FillDiagnosticKind, TKinds[number]>] extends [never]
      ? unknown
      : never),
): TKinds => kinds;

/** Every kind, in reporting order; omitting one fails typecheck. */
export const FILL_DIAGNOSTIC_KINDS = everyKind([
  "unmatchedPlaceholders",
  "aiFieldErrors",
  "undecidedConditions",
  "clauseWarnings",
  "structureErrors",
  "unusedValues",
  "unrestoredFields",
]);

/** The fill outcomes the diagnostics are read from: every member of the fill
 *  service's result except the document itself. Derived from that result, so
 *  a diagnostic the service adds lands here and must be read by
 *  {@link fillDiagnosticsOf} before anything compiles. */
export type FillDiagnosticSources = Omit<FilledDocx, FilledDocumentMember>;

const isUndecided = (
  condition: ResolvedAiCondition,
): condition is UndecidedAiCondition => condition.state === "undecided";

/** What the fill's caller observed around the fill service. */
type FillBoundaryDiagnostics = {
  /** See {@link FillDiagnostics.unrestoredFields}; a caller without an
   *  anonymizing boundary has none. */
  unrestoredFields?: readonly string[] | undefined;
};

/** Read a fill result into its total diagnostics record. Every source member
 *  is destructured: one left unread fails typecheck below. */
export const fillDiagnosticsOf = (
  {
    unmatchedPlaceholders,
    aiFieldErrors,
    conditionDecisions,
    clauseWarnings,
    structureErrors,
    unusedValues,
    ...unread
  }: FillDiagnosticSources,
  { unrestoredFields = [] }: FillBoundaryDiagnostics = {},
): FillDiagnostics => {
  unread satisfies Record<PropertyKey, never>;
  return {
    unmatchedPlaceholders,
    aiFieldErrors,
    undecidedConditions: conditionDecisions.filter(isUndecided),
    clauseWarnings,
    structureErrors,
    unusedValues,
    unrestoredFields,
  };
};

const blockingOnly = <TEntry>(
  entries: readonly TEntry[],
  grade: (entry: TEntry) => FillDiagnosticSeverity,
): readonly TEntry[] => entries.filter((entry) => grade(entry) === "blocking");

/** The blocking entries of each kind. Total by its return type. */
const blockingDiagnostics = (diagnostics: FillDiagnostics): FillDiagnostics => {
  const grades: FillDiagnosticGrades = FILL_DIAGNOSTIC_GRADES;
  return {
    unmatchedPlaceholders: blockingOnly(
      diagnostics.unmatchedPlaceholders,
      grades.unmatchedPlaceholders,
    ),
    aiFieldErrors: blockingOnly(
      diagnostics.aiFieldErrors,
      grades.aiFieldErrors,
    ),
    undecidedConditions: blockingOnly(
      diagnostics.undecidedConditions,
      grades.undecidedConditions,
    ),
    clauseWarnings: blockingOnly(
      diagnostics.clauseWarnings,
      grades.clauseWarnings,
    ),
    structureErrors: blockingOnly(
      diagnostics.structureErrors,
      grades.structureErrors,
    ),
    unusedValues: blockingOnly(diagnostics.unusedValues, grades.unusedValues),
    unrestoredFields: blockingOnly(
      diagnostics.unrestoredFields,
      grades.unrestoredFields,
    ),
  };
};

type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

type TemplateFillShortfall = {
  diagnostics: FillDiagnostics;
  /** The blocking entries only, per kind. */
  blocking: FillDiagnostics;
  /** The kinds with at least one blocking entry, in reporting order. */
  blockingKinds: NonEmptyReadonlyArray<FillDiagnosticKind>;
};

type TemplateFillCompletionDecision =
  | { type: "complete"; diagnostics: FillDiagnostics }
  | ({ type: "accepted_partial" } & TemplateFillShortfall)
  | ({ type: "rejected_partial" } & TemplateFillShortfall);

type DecideTemplateFillCompletionOptions = {
  mode: TemplateFillCompletionMode;
  diagnostics: FillDiagnostics;
};

/**
 * Turn a fill's diagnostics plus the caller's declared policy into a closed
 * decision. A fill is complete iff every diagnostic it carries grades
 * non-blocking; otherwise `require_complete` rejects it and `allow_partial`
 * reports it back to the caller.
 */
export const decideTemplateFillCompletion = ({
  mode,
  diagnostics,
}: DecideTemplateFillCompletionOptions): TemplateFillCompletionDecision => {
  const blocking = blockingDiagnostics(diagnostics);
  const [firstKind, ...otherKinds] = FILL_DIAGNOSTIC_KINDS.filter(
    (kind) => blocking[kind].length > 0,
  );
  if (firstKind === undefined) {
    return { type: "complete", diagnostics };
  }
  const shortfall: TemplateFillShortfall = {
    diagnostics,
    blocking,
    blockingKinds: [firstKind, ...otherKinds],
  };
  return mode === "allow_partial"
    ? { type: "accepted_partial", ...shortfall }
    : { type: "rejected_partial", ...shortfall };
};

/** The recorded status of a fill (`template_fills.status` and its audit
 *  event): the decision under a policy that accepts partial fills, so a fill
 *  is recorded `success` only when it is complete. */
export const templateFillStatus = (
  diagnostics: FillDiagnostics,
): TemplateFillStatus =>
  decideTemplateFillCompletion({ mode: "allow_partial", diagnostics }).type ===
  "complete"
    ? "success"
    : "partial";

/** The summary line keeps to the first few items; the full set travels in
 *  {@link fillShortfallIssues}. */
const previewList = (items: readonly string[]): string => {
  const preview = items.slice(0, 10);
  const omitted = items.length - preview.length;
  return `${preview.join(", ")}${omitted > 0 ? ` (${omitted} more omitted)` : ""}`;
};

const clauseWarningName = (warning: ClauseDirectiveWarning): string =>
  warning.slotKey ?? warning.clauseName;

const SHORTFALL_SUMMARIES = {
  unmatchedPlaceholders: (d) =>
    `unmatched placeholders: ${previewList(d.unmatchedPlaceholders)}`,
  aiFieldErrors: (d) =>
    `AI-drafted fields that failed: ${previewList(d.aiFieldErrors.map(({ valuePath }) => valuePath))}`,
  undecidedConditions: (d) =>
    `AI-decided conditions left undecided: ${previewList(d.undecidedConditions.map(({ path, reason }) => `${path} (${reason})`))}`,
  clauseWarnings: (d) =>
    `clauses inserted with unresolved directives: ${previewList(d.clauseWarnings.map(clauseWarningName))}`,
  structureErrors: (d) =>
    `template directives that could not be applied: ${previewList(d.structureErrors.map(({ paragraphIndex }) => `paragraph ${paragraphIndex + 1}`))}`,
  unusedValues: (d) => `unused values: ${previewList(d.unusedValues)}`,
  unrestoredFields: (d) =>
    `fields still holding an anonymization placeholder: ${previewList(d.unrestoredFields)}`,
} as const satisfies Record<
  FillDiagnosticKind,
  (diagnostics: FillDiagnostics) => string
>;

/** One summary line naming every non-empty kind of the given diagnostics:
 *  a caller retrying needs to know each reason the fill fell short. */
export const describeFillShortfall = (diagnostics: FillDiagnostics): string =>
  FILL_DIAGNOSTIC_KINDS.filter((kind) => diagnostics[kind].length > 0)
    .map((kind) => SHORTFALL_SUMMARIES[kind](diagnostics))
    .join("; ");

/** One issue per diagnostic entry, each addressed at what a retry changes. */
export const fillShortfallIssues = (
  diagnostics: FillDiagnostics,
): { path: string; message: string }[] => [
  ...diagnostics.unmatchedPlaceholders.map((placeholder) => ({
    path: `values.${placeholder}`,
    message: "Template placeholder was not filled",
  })),
  ...diagnostics.aiFieldErrors.map((error) => ({
    path: `values.${error.valuePath}`,
    message: error.message,
  })),
  ...diagnostics.undecidedConditions.map((condition) => ({
    path: `values.${condition.path}`,
    message: `AI-decided condition "${condition.label}" was left undecided (${condition.reason}); supply true or false for it.`,
  })),
  ...diagnostics.clauseWarnings.map((warning) => ({
    path: `clauses.${clauseWarningName(warning)}`,
    message: warning.message,
  })),
  ...diagnostics.structureErrors.map((error) => ({
    path: `template.paragraphs.${error.paragraphIndex}`,
    message: error.message,
  })),
  ...diagnostics.unusedValues.map((key) => ({
    path: `values.${key}`,
    message: "Value key does not match a template field",
  })),
  ...diagnostics.unrestoredFields.map((fieldPath) => ({
    path: `values.${fieldPath}`,
    message:
      "The value still holds an anonymization placeholder, so the document carries the placeholder instead of the real value; supply the real value.",
  })),
];
