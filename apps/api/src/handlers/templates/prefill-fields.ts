/**
 * Pure half of the AI prefill endpoint: map a template's fillable fields to
 * short sequential ids (f1, f2, …) for the model conversation, render the
 * field list for the prompt, and map the model's structured answer back to
 * field paths. The model never sees UUIDs or raw manifest internals.
 *
 * Formula (derived) fields and `{{#each}}` array fields are skipped: the
 * former are computed at fill time, the latter have no single value to
 * propose. Composite fields are flattened to one target per part.
 */

import type { ResolvedField } from "@/api/handlers/docx/types";

export type PrefillTarget = {
  /** Simple mapped id used in the model conversation (f1, f2, …). */
  id: string;
  /** The field's path in the template (fill-values key). */
  path: string;
  /** Composite part key when the target is one part of a composite field. */
  partKey: string | null;
  label: string | null;
  inputType: string;
  /** Allowed values for select inputs; free-form otherwise. */
  options: string[] | null;
};

const targetInputType = (field: ResolvedField): string =>
  field.inputType ?? (field.kind === "boolean" ? "boolean" : "text");

export const buildPrefillTargets = (
  fields: readonly ResolvedField[],
): PrefillTarget[] => {
  const targets: PrefillTarget[] = [];
  let next = 1;
  const allocateId = () => `f${String(next++)}`;

  for (const field of fields) {
    if (field.formula !== undefined || field.kind === "array") {
      continue;
    }

    const parts =
      field.parts !== undefined &&
      field.parts.length > 0 &&
      field.format !== undefined
        ? field.parts
        : null;

    if (parts) {
      for (const part of parts) {
        targets.push({
          id: allocateId(),
          path: field.path,
          partKey: part.key,
          label: part.label ?? `${field.label ?? field.path} (${part.key})`,
          inputType: part.inputType,
          options:
            part.inputType === "select" &&
            part.options &&
            part.options.length > 0
              ? part.options
              : null,
        });
      }
      continue;
    }

    const inputType = targetInputType(field);
    targets.push({
      id: allocateId(),
      path: field.path,
      partKey: null,
      label: field.label ?? null,
      inputType,
      options:
        inputType === "select" && field.options && field.options.length > 0
          ? field.options
          : null,
    });
  }

  return targets;
};

const targetFormatHint = (target: PrefillTarget): string => {
  if (target.options) {
    return `select, one of: ${target.options.map((o) => JSON.stringify(o)).join(", ")}`;
  }
  if (target.inputType === "date") {
    return "date, ISO 8601 (YYYY-MM-DD)";
  }
  if (target.inputType === "boolean") {
    return "boolean, true or false";
  }
  if (target.inputType === "number") {
    return "number, digits only";
  }
  return target.inputType;
};

/** One prompt line per target: `f1: company.name — "Company name" (text)`. */
export const renderPrefillTargets = (
  targets: readonly PrefillTarget[],
): string =>
  targets
    .map((target) => {
      const pathLabel = target.partKey
        ? `${target.path} [part ${target.partKey}]`
        : target.path;
      const label = target.label ? ` — "${target.label}"` : "";
      return `${target.id}: ${pathLabel}${label} (${targetFormatHint(target)})`;
    })
    .join("\n");

export type PrefillModelField = {
  id: string;
  value: string | null;
  sourceSnippet: string | null;
};

export type PrefillSuggestion = {
  path: string;
  partKey: string | null;
  value: string;
  sourceSnippet: string | null;
};

const MAX_SNIPPET_CHARS = 300;
const MAX_VALUE_CHARS = 4000;

const TRUE_WORDS = new Set(["true", "yes", "1"]);
const FALSE_WORDS = new Set(["false", "no", "0"]);

/** Normalize one model value against its target's input type; null drops the
 *  suggestion (unparseable boolean, value outside a select's options, …). */
const normalizeValue = (
  target: PrefillTarget,
  rawValue: string,
): string | null => {
  const value = rawValue.trim().slice(0, MAX_VALUE_CHARS);
  if (value === "") {
    return null;
  }
  if (target.options) {
    const exact = target.options.find((option) => option === value);
    if (exact !== undefined) {
      return exact;
    }
    const caseInsensitive = target.options.find(
      (option) => option.toLowerCase() === value.toLowerCase(),
    );
    return caseInsensitive ?? null;
  }
  if (target.inputType === "boolean") {
    const lower = value.toLowerCase();
    if (TRUE_WORDS.has(lower)) {
      return "true";
    }
    if (FALSE_WORDS.has(lower)) {
      return "false";
    }
    return null;
  }
  return value;
};

/** Map the model's answer back to field paths: unknown ids and empty/null
 *  values are dropped, values are normalized per input type, and only the
 *  first answer per target wins. */
export const mapPrefillResults = (
  targets: readonly PrefillTarget[],
  modelFields: readonly PrefillModelField[],
): PrefillSuggestion[] => {
  const byId = new Map(targets.map((target) => [target.id, target]));
  const seen = new Set<string>();
  const suggestions: PrefillSuggestion[] = [];

  for (const field of modelFields) {
    const target = byId.get(field.id);
    if (!target || seen.has(field.id) || field.value === null) {
      continue;
    }
    const value = normalizeValue(target, field.value);
    if (value === null) {
      continue;
    }
    seen.add(field.id);
    const snippet = field.sourceSnippet?.trim() ?? "";
    suggestions.push({
      path: target.path,
      partKey: target.partKey,
      value,
      sourceSnippet:
        snippet === "" ? null : snippet.slice(0, MAX_SNIPPET_CHARS),
    });
  }

  return suggestions;
};
