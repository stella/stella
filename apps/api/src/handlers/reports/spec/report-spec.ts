/**
 * Declarative report spec.
 *
 * A spec is a small JSON document (`spec.json` plus optional `prompts/*.md`)
 * that lists the sections of a report in order. `render-report-spec.ts`
 * interprets it against the assembled report data and emits a DOCX through
 * the Folio document model. No expression language: every section is a fixed
 * kind with a few knobs, and string interpolation is limited to an explicit
 * allowlist of `{{key}}` placeholders checked at parse time.
 */

import { Result } from "better-result";
import * as v from "valibot";

import { SEVERITY_ORDER } from "@/api/handlers/reports/report-findings";
import { ConfigurationError } from "@/api/lib/errors/tagged-errors";

/** Placeholders a root-level string (cover) may interpolate. */
export const ROOT_INTERPOLATION_KEYS = [
  "workspace.name",
  "generatedAt",
] as const;
/** Placeholders a `grouped` heading may interpolate, on top of the root set. */
export const GROUP_INTERPOLATION_KEYS = [
  ...ROOT_INTERPOLATION_KEYS,
  "group.documentType",
] as const;

export type RootInterpolationKey = (typeof ROOT_INTERPOLATION_KEYS)[number];
export type GroupInterpolationKey = (typeof GROUP_INTERPOLATION_KEYS)[number];

const PLACEHOLDER_PATTERN = /\{\{\s*(?<key>[^{}]*?)\s*\}\}/gu;

/** Every `{{key}}` in `text`, trimmed; a renderer substitutes these. */
export const placeholderKeys = (text: string): string[] =>
  [...text.matchAll(PLACEHOLDER_PATTERN)].map(
    (match) => match.groups?.["key"] ?? "",
  );

/** Substitute the allowlisted placeholders; a key outside `values` was
 *  rejected at parse time, so there is no fallback branch here. */
export const interpolate = (
  text: string,
  values: Record<string, string>,
): string =>
  text.replaceAll(
    PLACEHOLDER_PATTERN,
    (_match, key: string) => values[key] ?? "",
  );

const interpolatedString = (allowed: readonly string[]) =>
  v.pipe(
    v.string(),
    v.check(
      (text) => {
        const unknown = placeholderKeys(text).filter(
          (key) => !allowed.includes(key),
        );
        return unknown.length === 0;
      },
      `Unknown placeholder; allowed: ${allowed.map((key) => `{{${key}}}`).join(", ")}`,
    ),
  );

const rootString = interpolatedString(ROOT_INTERPOLATION_KEYS);
const groupString = interpolatedString(GROUP_INTERPOLATION_KEYS);

const headingLevel = v.picklist([1, 2, 3]);
const positiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));

const promptSchema = v.union([
  v.strictObject({ text: v.pipe(v.string(), v.minLength(1)) }),
  /** `prompts/<ref>.md` next to `spec.json`. */
  v.strictObject({ ref: v.pipe(v.string(), v.regex(/^[\w-]+$/u)) }),
]);

export const FINDING_COLUMNS = [
  "severity",
  "contract",
  "documentType",
  "issue",
  "verdict",
  "rationale",
  "recommendation",
] as const;
export type FindingColumn = (typeof FINDING_COLUMNS)[number];

export const FINDING_PARTS = [
  "rationale",
  "matchedRef",
  "idealText",
  "guidance",
  "negotiation",
] as const;
export type FindingPart = (typeof FINDING_PARTS)[number];

export const CITATION_MODES = ["endnote", "inline", "none"] as const;
export type CitationMode = (typeof CITATION_MODES)[number];

const coverSection = v.strictObject({
  kind: v.literal("cover"),
  title: rootString,
  subtitle: v.optional(rootString),
  notice: v.optional(rootString),
});

const tocSection = v.strictObject({
  kind: v.literal("toc"),
  levels: v.optional(v.strictObject({ from: positiveInt, to: positiveInt })),
});

const pageBreakSection = v.strictObject({ kind: v.literal("page-break") });

const narrativeSection = v.strictObject({
  kind: v.literal("narrative"),
  heading: v.optional(v.string()),
  level: v.optional(headingLevel),
  prompt: promptSchema,
});

const statsSection = v.strictObject({
  kind: v.literal("stats"),
  heading: v.optional(v.string()),
  by: v.picklist(["severity", "documentType"]),
});

/** The `stats` variant allowed inside a group: the group IS one document
 *  type, so only the severity breakdown applies. */
const groupStatsSection = v.strictObject({
  kind: v.literal("stats"),
  heading: v.optional(v.string()),
  by: v.literal("severity"),
});

const findingsTableSection = v.strictObject({
  kind: v.literal("findings-table"),
  heading: v.optional(v.string()),
  severity: v.optional(
    v.pipe(v.array(v.picklist(SEVERITY_ORDER)), v.minLength(1)),
  ),
  columns: v.pipe(v.array(v.picklist(FINDING_COLUMNS)), v.minLength(1)),
  limit: v.optional(positiveInt),
});

const findingsSection = v.strictObject({
  kind: v.literal("findings"),
  include: v.array(v.picklist(FINDING_PARTS)),
  citations: v.picklist(CITATION_MODES),
  suppressVerdicts: v.optional(v.array(v.string())),
});

const perContractSection = v.strictObject({
  kind: v.literal("per-contract"),
  heading: v.optional(v.string()),
});

export const MATRIX_COLUMNS = ["all", "graded"] as const;
export type MatrixColumns = (typeof MATRIX_COLUMNS)[number];

const matrixSection = v.strictObject({
  kind: v.literal("matrix"),
  heading: v.optional(v.string()),
  /** `graded` keeps only verdict columns (plus the contract name). */
  columns: v.optional(v.picklist(MATRIX_COLUMNS), "all"),
});

const groupChildSchema = v.variant("kind", [
  narrativeSection,
  groupStatsSection,
  findingsTableSection,
  findingsSection,
  perContractSection,
]);

const groupedSection = v.strictObject({
  kind: v.literal("grouped"),
  by: v.literal("documentType"),
  order: v.picklist(["redFlagsDesc", "name"]),
  heading: groupString,
  level: v.optional(v.picklist([1, 2])),
  children: v.array(groupChildSchema),
});

/** Sections allowed anywhere except inside another appendix. */
const appendixChildSchema = v.variant("kind", [
  coverSection,
  tocSection,
  pageBreakSection,
  narrativeSection,
  statsSection,
  findingsTableSection,
  groupedSection,
  findingsSection,
  perContractSection,
  matrixSection,
]);

const appendixSection = v.strictObject({
  kind: v.literal("appendix"),
  heading: v.string(),
  children: v.array(appendixChildSchema),
});

const sectionSchema = v.variant("kind", [
  coverSection,
  tocSection,
  pageBreakSection,
  narrativeSection,
  statsSection,
  findingsTableSection,
  groupedSection,
  findingsSection,
  perContractSection,
  matrixSection,
  appendixSection,
]);

export const reportSpecSchema = v.strictObject({
  version: v.literal(1),
  name: v.pipe(v.string(), v.minLength(1)),
  description: v.optional(v.string()),
  /** DOCX shell filename next to `spec.json`. Parsed, not yet applied. */
  shell: v.optional(v.pipe(v.string(), v.endsWith(".docx"))),
  sections: v.array(sectionSchema),
});

export type ReportSpec = v.InferOutput<typeof reportSpecSchema>;
export type ReportSection = v.InferOutput<typeof sectionSchema>;
export type GroupChildSection = v.InferOutput<typeof groupChildSchema>;
export type ReportSectionKind = ReportSection["kind"];

/** Every section kind the schema accepts; the renderer's dispatch map is
 *  checked total against this list. */
export const REPORT_SECTION_KINDS = sectionSchema.options.map(
  (option) => option.entries.kind.literal,
);

export const parseReportSpec = (
  input: unknown,
): Result<ReportSpec, ConfigurationError> => {
  const parsed = v.safeParse(reportSpecSchema, input);
  if (parsed.success) {
    return Result.ok(parsed.output);
  }
  const issues = v.flatten(parsed.issues);
  const details = [
    ...(issues.root ?? []),
    ...Object.entries(issues.nested ?? {}).map(
      ([path, messages]) => `${path}: ${(messages ?? []).join("; ")}`,
    ),
  ].join("\n");
  return Result.err(
    new ConfigurationError({ message: `Invalid report spec:\n${details}` }),
  );
};
