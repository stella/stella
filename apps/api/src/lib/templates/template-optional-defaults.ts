import { resolvePath } from "@stll/template-conditions";

import {
  mapRepeatablePath,
  readRowSubPath,
} from "@/api/lib/docx/repeatable-paths";

type TemplateFieldRequiredness = {
  aiPrompt?: string | undefined;
  condition?: unknown;
  conditionAst?: unknown;
  formula?: unknown;
  path: string;
  required?: boolean | undefined;
  source?: unknown;
  validation?: { required?: boolean | undefined } | undefined;
};

/** {@link TemplateFieldRequiredness} plus the display metadata a caller
 *  reports back to the person filling. */
export type TemplateFieldDescriptor = TemplateFieldRequiredness & {
  label?: string | undefined;
  inputType?: string | undefined;
  options?: readonly string[] | undefined;
};

/** One required field the caller omitted (or left empty), returned instead of
 *  either inventing a value or silently leaving the marker unfilled. */
export type MissingRequiredField = {
  path: string;
  label: string | null;
  inputType: string;
  options: string[] | null;
};

/**
 * Every fill boundary's required-fields stance. `"enforce"` is the fill
 * contract every real fill (chat/MCP tool, REST download, workspace
 * persistence) must apply. `"allow-partial"` is the one legitimate exception
 * — a live preview rendering an in-progress form, which by definition has not
 * been fully filled yet — and must be named explicitly at the call site
 * rather than left as a route that simply never calls the gate.
 */
export type RequiredFieldsPolicy = "allow-partial" | "enforce";

type ApplyOmittedOptionalPlaceholderDefaultsOptions = {
  fields: readonly TemplateFieldRequiredness[];
  placeholderPaths: Iterable<string>;
  values: Record<string, unknown>;
};

type OptionalPlaceholderDefaults = {
  defaultedPaths: string[];
  values: Record<string, unknown>;
};

export const isTemplateFieldRequired = (
  field: TemplateFieldRequiredness,
): boolean => field.required ?? field.validation?.required ?? false;

const isUserEnteredField = (field: TemplateFieldRequiredness): boolean =>
  field.formula === undefined &&
  field.condition === undefined &&
  field.conditionAst === undefined &&
  field.source === undefined;

const isAiFillableField = (field: TemplateFieldRequiredness): boolean =>
  field.aiPrompt !== undefined && field.aiPrompt !== "";

/** A required value counts as missing when it is entirely absent, or (for
 *  text) when it is empty once surrounding whitespace is trimmed — matching
 *  the web fill form, which already classifies `value.trim() === ""` as
 *  missing rather than accepting a marker filled with only spaces. */
const isMissingRequiredValue = (value: unknown): boolean => {
  if (value === undefined) {
    return true;
  }
  return typeof value === "string" && value.trim() === "";
};

/**
 * A required field the fill boundary must reject rather than silently fill or
 * leave blank: declared `required`, entered directly by the person filling
 * (not formula/condition/source-derived, which resolve on their own), not
 * AI-fillable (an omitted `aiPrompt` field is drafted, not missing), and
 * absent or empty (including whitespace-only text) in the submitted values.
 * Prevents the two invention-by-omission failure modes — a model fabricating
 * a value it was never given, or silently leaving a `{{marker}}` unfilled —
 * for exactly the fields where only the user can supply the answer.
 *
 * A dotted path whose container resolves to an array (a `{{#each}}` loop item
 * field, e.g. `persons.member` against `{ persons: [{ member: "..." }] }`) is
 * checked per row via {@link mapRepeatablePath}: `resolvePath` alone cannot
 * index into the array and would report every such field as always missing.
 * A loop with no rows has nothing to omit, so it is never flagged; a required
 * item field is missing only when a row that exists leaves it empty.
 */
export const isMissingRequiredFieldValue = ({
  field,
  values,
}: {
  field: TemplateFieldRequiredness;
  values: Record<string, unknown>;
}): boolean => {
  if (
    !isTemplateFieldRequired(field) ||
    !isUserEnteredField(field) ||
    isAiFillableField(field)
  ) {
    return false;
  }

  let missingInRow = false;
  const isRepeatable = mapRepeatablePath(
    values,
    field.path,
    ({ row, subPath }) => {
      if (isMissingRequiredValue(readRowSubPath(row, subPath))) {
        missingInRow = true;
      }
    },
  );
  if (isRepeatable) {
    return missingInRow;
  }

  return isMissingRequiredValue(resolvePath(field.path, values));
};

/**
 * The shared required-fields gate: every fill boundary — the fill service,
 * every REST fill route, and the workspace-persistence path — must run this
 * before filling and reject when it reports a non-empty list, so a required
 * field can never be silently invented or left as a raw `{{marker}}` in the
 * output. `policy` is mandatory so a caller that legitimately wants partial
 * values (the live fill-preview route) names that exception explicitly
 * (`"allow-partial"`) rather than simply omitting the call.
 */
export const collectMissingRequiredFields = ({
  fields,
  policy,
  values,
}: {
  fields: readonly TemplateFieldDescriptor[];
  policy: RequiredFieldsPolicy;
  values: Record<string, unknown>;
}): MissingRequiredField[] => {
  if (policy === "allow-partial") {
    return [];
  }
  return fields
    .filter((field) => isMissingRequiredFieldValue({ field, values }))
    .map((field) => ({
      path: field.path,
      label: field.label ?? null,
      inputType: field.inputType ?? "text",
      options: field.options ? [...field.options] : null,
    }));
};

/**
 * Give omitted optional scalar placeholders their form-equivalent empty value.
 * The web form already submits an empty string for an optional empty input;
 * machine callers commonly omit the key instead. Normalizing both forms here
 * keeps every fill boundary on the same contract and prevents an optional
 * field from leaking a raw `{{marker}}` into an otherwise complete document.
 *
 * Only exact placeholder paths are defaulted. Condition drivers, arrays, and
 * parent objects are intentionally left to the block/manifest pipeline.
 */
export const applyOmittedOptionalPlaceholderDefaults = ({
  fields,
  placeholderPaths,
  values,
}: ApplyOmittedOptionalPlaceholderDefaultsOptions): OptionalPlaceholderDefaults => {
  const placeholders = new Set(placeholderPaths);
  const defaultedPaths: string[] = [];
  const normalized = { ...values };

  for (const field of fields) {
    if (
      !isUserEnteredField(field) ||
      isTemplateFieldRequired(field) ||
      !placeholders.has(field.path) ||
      resolvePath(field.path, normalized) !== undefined
    ) {
      continue;
    }
    normalized[field.path] = "";
    defaultedPaths.push(field.path);
  }

  return { defaultedPaths, values: normalized };
};
