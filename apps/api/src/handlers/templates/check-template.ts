/**
 * Pre-flight template validation ("Check template").
 *
 * Pure analysis over already-loaded template artifacts (discovery result,
 * manifest, clause slots, clause links): surfaces authoring problems as a
 * bounded list of typed findings before anyone hits them at fill time.
 */

import type { ClauseSlot } from "@/api/handlers/docx/discover-clause-slots";
import type {
  DiscoveredTemplate,
  TemplateManifest,
} from "@/api/handlers/docx/types";

// ── Findings ─────────────────────────────────────────────

export type TemplateCheckFinding =
  | {
      code: "structureError";
      severity: "error";
      directive: string;
      paragraphIndex: number;
    }
  | { code: "markerWithoutField"; severity: "warning"; path: string }
  | { code: "unplacedField"; severity: "warning"; path: string }
  | { code: "slotWithoutClause"; severity: "error"; slotName: string }
  | { code: "linkWithoutSlot"; severity: "warning"; slotName: string }
  | { code: "fieldMissingLabel"; severity: "warning"; path: string }
  | { code: "fieldMissingInputType"; severity: "warning"; path: string }
  | { code: "selectWithoutOptions"; severity: "error"; path: string }
  | {
      code: "formulaUnknownPath";
      severity: "error";
      path: string;
      reference: string;
    }
  | {
      code: "conditionUnknownPath";
      severity: "error";
      conditionName: string;
      reference: string;
    };

/** Hard cap so a pathological template cannot produce an unbounded payload. */
export const MAX_CHECK_FINDINGS = 200;

// ── Expression path extraction ───────────────────────────

// Mirrors the tokenizer of `evaluateNumericExpression` in
// @stll/template-conditions (compute.ts), which does not export a path
// extractor: numeric literals (group 1, with `_` separators) are consumed
// first so they are never mistaken for identifiers (group 2).
const FORMULA_TOKEN_RE =
  /([0-9][0-9_]*(?:\.[0-9]+)?)|([\p{L}_][\p{L}\p{N}_.]*)/gu;

const FORMULA_FUNCTIONS: ReadonlySet<string> = new Set([
  "min",
  "max",
  "round",
  "abs",
  "floor",
  "ceil",
]);

const extractFormulaPaths = (expression: string): string[] => {
  const paths: string[] = [];
  for (const match of expression.matchAll(FORMULA_TOKEN_RE)) {
    const ident = match[2];
    if (ident !== undefined && !FORMULA_FUNCTIONS.has(ident)) {
      paths.push(ident);
    }
  }
  return paths;
};

// Mirrors the condition tokenizer of `evaluateCondition` in
// @stll/template-conditions (index.ts): string literals and operators are
// consumed first; group 2 captures candidate identifiers.
const CONDITION_TOKEN_RE =
  /("(?:[^"\\]|\\.)*")|==|!=|>=|<=|>|<|!(?!=)|and\b|or\b|[()]|([\p{L}\p{N}_.]+)/gu;

const STARTS_WITH_DIGIT_RE = /^\d/u;

const extractConditionPaths = (expression: string): string[] => {
  const paths: string[] = [];
  for (const match of expression.matchAll(CONDITION_TOKEN_RE)) {
    const ident = match[2];
    if (
      ident === undefined ||
      ident === "true" ||
      ident === "false" ||
      STARTS_WITH_DIGIT_RE.test(ident)
    ) {
      continue;
    }
    paths.push(ident);
  }
  return paths;
};

// ── Check builder ────────────────────────────────────────

/** The minimal link shape the check needs (subset of a templateClauses row
 *  joined with its clause; `clause` is null when the clause was deleted). */
export type TemplateCheckClauseLink = {
  slotName: string | null;
  clause: { id: string } | null;
};

type BuildTemplateCheckFindingsOptions = {
  discovered: DiscoveredTemplate;
  manifest: TemplateManifest | null;
  clauseSlots: readonly ClauseSlot[];
  clauseLinks: readonly TemplateCheckClauseLink[];
};

const rootOf = (path: string): string => path.split(".")[0] ?? path;

// Structure errors (unbalanced/misplaced block directives) — already
// computed by discovery; surface them as-is.
const structureFindings = (
  discovered: DiscoveredTemplate,
): TemplateCheckFinding[] =>
  discovered.structureErrors.map((err) => ({
    code: "structureError",
    severity: "error",
    directive: err.directive,
    paragraphIndex: err.paragraphIndex,
  }));

type MarkerCoverageOptions = {
  markerNames: readonly string[];
  manifestFields: TemplateManifest["fields"];
};

// Markers in the document with no manifest field entry, and manifest fields
// whose marker appears nowhere. A dotted marker (sellers.name) counts as
// covered by a manifest entry for its root (the array/object field).
// Unplaced fields are a warning only: they may deliberately feed conditions,
// formulas, or optionsFrom.
const markerCoverageFindings = ({
  markerNames,
  manifestFields,
}: MarkerCoverageOptions): TemplateCheckFinding[] => {
  const findings: TemplateCheckFinding[] = [];
  const manifestPaths = new Set(manifestFields.map((field) => field.path));
  const markerSet = new Set(markerNames);

  for (const name of markerNames) {
    if (!manifestPaths.has(name) && !manifestPaths.has(rootOf(name))) {
      findings.push({
        code: "markerWithoutField",
        severity: "warning",
        path: name,
      });
    }
  }

  for (const field of manifestFields) {
    const placed =
      markerSet.has(field.path) ||
      markerNames.some((name) => name.startsWith(`${field.path}.`));
    if (!placed) {
      findings.push({
        code: "unplacedField",
        severity: "warning",
        path: field.path,
      });
    }
  }

  return findings;
};

type ClauseSlotOptions = {
  clauseSlots: readonly ClauseSlot[];
  clauseLinks: readonly TemplateCheckClauseLink[];
};

// Clause slots with no linked clause (a link whose clause was deleted does
// not resolve either), and links whose slot name matches no marker.
const clauseSlotFindings = ({
  clauseSlots,
  clauseLinks,
}: ClauseSlotOptions): TemplateCheckFinding[] => {
  const findings: TemplateCheckFinding[] = [];

  const linkedSlotNames = new Set<string>();
  for (const link of clauseLinks) {
    if (link.slotName !== null && link.clause !== null) {
      linkedSlotNames.add(link.slotName);
    }
  }
  for (const slot of clauseSlots) {
    if (!linkedSlotNames.has(slot.name)) {
      findings.push({
        code: "slotWithoutClause",
        severity: "error",
        slotName: slot.name,
      });
    }
  }

  const slotNames = new Set(clauseSlots.map((slot) => slot.name));
  for (const link of clauseLinks) {
    if (link.slotName !== null && !slotNames.has(link.slotName)) {
      findings.push({
        code: "linkWithoutSlot",
        severity: "warning",
        slotName: link.slotName,
      });
    }
  }

  return findings;
};

// Field metadata quality: missing label, missing input type (skipped for
// derived/composite fields, which render no plain input), select with no
// option source.
const fieldMetadataFindings = (
  manifestFields: TemplateManifest["fields"],
): TemplateCheckFinding[] => {
  const findings: TemplateCheckFinding[] = [];

  for (const field of manifestFields) {
    if (field.label === undefined || field.label.trim() === "") {
      findings.push({
        code: "fieldMissingLabel",
        severity: "warning",
        path: field.path,
      });
    }
    const rendersOwnInput =
      field.formula === undefined && field.parts === undefined;
    if (rendersOwnInput && field.inputType === undefined) {
      findings.push({
        code: "fieldMissingInputType",
        severity: "warning",
        path: field.path,
      });
    }
    if (
      field.inputType === "select" &&
      (field.options === undefined || field.options.length === 0) &&
      field.optionsFrom === undefined
    ) {
      findings.push({
        code: "selectWithoutOptions",
        severity: "error",
        path: field.path,
      });
    }
  }

  return findings;
};

type ExpressionReferenceOptions = {
  manifest: TemplateManifest | null;
  knownPaths: ReadonlySet<string>;
};

// Formula fields referencing unknown paths, and named conditions referencing
// paths that are neither fields nor other named conditions.
const expressionReferenceFindings = ({
  manifest,
  knownPaths,
}: ExpressionReferenceOptions): TemplateCheckFinding[] => {
  const findings: TemplateCheckFinding[] = [];

  for (const field of manifest?.fields ?? []) {
    if (field.formula === undefined) {
      continue;
    }
    const seen = new Set<string>();
    for (const reference of extractFormulaPaths(field.formula)) {
      if (knownPaths.has(reference) || seen.has(reference)) {
        continue;
      }
      seen.add(reference);
      findings.push({
        code: "formulaUnknownPath",
        severity: "error",
        path: field.path,
        reference,
      });
    }
  }

  const conditions = manifest?.conditions ?? [];
  const conditionNames = new Set(conditions.map((condition) => condition.name));
  for (const condition of conditions) {
    const seen = new Set<string>();
    for (const reference of extractConditionPaths(condition.expression)) {
      if (
        knownPaths.has(reference) ||
        conditionNames.has(reference) ||
        seen.has(reference)
      ) {
        continue;
      }
      seen.add(reference);
      findings.push({
        code: "conditionUnknownPath",
        severity: "error",
        conditionName: condition.name,
        reference,
      });
    }
  }

  return findings;
};

// Paths an expression may legitimately reference: manifest fields, document
// markers, and discovery-inferred fields (condition drivers, array items).
const collectKnownPaths = (
  discovered: DiscoveredTemplate,
  manifestFields: TemplateManifest["fields"],
  markerNames: readonly string[],
): Set<string> => {
  const knownPaths = new Set<string>(markerNames);
  for (const field of manifestFields) {
    knownPaths.add(field.path);
  }
  for (const field of discovered.fields) {
    knownPaths.add(field.path);
    for (const item of field.itemFields ?? []) {
      knownPaths.add(`${field.path}.${item.path}`);
    }
  }
  return knownPaths;
};

export const buildTemplateCheckFindings = ({
  discovered,
  manifest,
  clauseSlots,
  clauseLinks,
}: BuildTemplateCheckFindingsOptions): TemplateCheckFinding[] => {
  const manifestFields = manifest?.fields ?? [];
  // @-prefixed markers (clause slots, numbering) are already excluded by
  // discovery; these are user-fillable markers only.
  const markerNames = discovered.placeholders.map((p) => p.name);

  const findings: TemplateCheckFinding[] = [
    ...structureFindings(discovered),
    ...markerCoverageFindings({ markerNames, manifestFields }),
    ...clauseSlotFindings({ clauseSlots, clauseLinks }),
    ...fieldMetadataFindings(manifestFields),
    ...expressionReferenceFindings({
      manifest,
      knownPaths: collectKnownPaths(discovered, manifestFields, markerNames),
    }),
  ];

  return findings.slice(0, MAX_CHECK_FINDINGS);
};
