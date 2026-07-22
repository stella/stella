import { resolvePath } from "@stll/template-conditions";

type TemplateFieldRequiredness = {
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
