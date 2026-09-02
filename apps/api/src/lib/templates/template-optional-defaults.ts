import { resolvePath } from "@stll/template-conditions";

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

/**
 * A required field the fill boundary must reject rather than silently fill or
 * leave blank: declared `required`, entered directly by the person filling
 * (not formula/condition/source-derived, which resolve on their own), not
 * AI-fillable (an omitted `aiPrompt` field is drafted, not missing), and
 * absent or empty in the submitted values. Prevents the two invention-by-
 * omission failure modes — a model fabricating a value it was never given, or
 * silently leaving a `{{marker}}` unfilled — for exactly the fields where
 * only the user can supply the answer.
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
  const value = resolvePath(field.path, values);
  return value === undefined || value === "";
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
