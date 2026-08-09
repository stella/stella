import type { ConditionNode } from "@stll/template-conditions";

import type { TemplateDateFormat } from "@/components/templates/template-date-format";
import {
  defaultCompositeFormat,
  type InputType,
  type LookupRegistry,
} from "@/components/templates/template-field-manifest";

/** A field's value source, resolved server-side at fill time. */
export type FieldSource =
  | { kind: "contact"; field: string }
  | { kind: "party"; role: string; field: string }
  | { kind: "matter"; field: string }
  | { kind: "attorney"; ref: string; field: string }
  | { kind: "firm"; field: string };

export type EditableLookupFormat = {
  key: string;
  template: string;
};

export type EditableLookup = {
  registry: LookupRegistry;
  formats: EditableLookupFormat[];
};

export type EditablePart = {
  key: string;
  inputType: "text" | "select";
  options: string[];
  label?: string | undefined;
  pattern?: string | undefined;
};

/** Exactly one value source is active for a field. */
export type TemplateValueSource =
  | { type: "input" }
  | { type: "composite"; parts: EditablePart[]; format: string }
  | { type: "composite-draft"; parts: EditablePart[]; format: string }
  | { type: "lookup"; lookup: EditableLookup }
  | { type: "formula"; formula: string }
  | { type: "binding"; source: FieldSource }
  | { type: "condition"; condition: string; conditionAst?: never }
  | { type: "condition"; condition?: never; conditionAst: ConditionNode };

/** Field-level validation mirrored from the backend DOCX contract. */
export type FieldValidation = {
  required?: boolean | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  min?: number | undefined;
  max?: number | undefined;
  pattern?: string | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
};

export type TemplateEditableField = {
  path: string;
  kind: string;
  label: string;
  hint?: string | undefined;
  inputType: InputType;
  required: boolean;
  options: string[];
  valueSource: TemplateValueSource;
  parts?: EditablePart[] | undefined;
  format?: string | undefined;
  optionsFrom?: string | undefined;
  lookup?: EditableLookup | undefined;
  formula?: string | undefined;
  source?: FieldSource | undefined;
  condition?: string | undefined;
  conditionAst?: ConditionNode | undefined;
  dateFormat?: TemplateDateFormat | undefined;
  validation?: FieldValidation | undefined;
};

export type EditableField = TemplateEditableField & {
  aiPrompt?: string | undefined;
  aiAdapt?: boolean | undefined;
  aiSeesDocument?: boolean | undefined;
};

type ValueSourceField = Pick<
  TemplateEditableField,
  | "parts"
  | "format"
  | "lookup"
  | "formula"
  | "source"
  | "condition"
  | "conditionAst"
  | "inputType"
>;

type ValueSourcePatch = Pick<
  TemplateEditableField,
  | "valueSource"
  | "parts"
  | "format"
  | "lookup"
  | "formula"
  | "source"
  | "condition"
  | "conditionAst"
>;

type ValueSourceOptions = { preserveDraft?: boolean };

/** Derive one active source from an untrusted or legacy field shape. */
export const templateValueSourceOf = (
  field: ValueSourceField,
  options: ValueSourceOptions = {},
): TemplateValueSource => {
  if (field.parts !== undefined && field.parts.length > 0) {
    const format = field.format?.trim() || defaultCompositeFormat(field.parts);
    if (format !== undefined && format !== "") {
      return { type: "composite", parts: field.parts, format };
    }
  }
  if (field.parts !== undefined && options.preserveDraft === true) {
    return {
      type: "composite-draft",
      parts: field.parts,
      format: field.format ?? "",
    };
  }
  if (field.formula !== undefined) {
    const formula = field.formula.trim();
    if (formula !== "" || options.preserveDraft === true) {
      return { type: "formula", formula };
    }
  }
  if (field.inputType === "boolean" && field.conditionAst !== undefined) {
    return { type: "condition", conditionAst: field.conditionAst };
  }
  if (field.inputType === "boolean" && field.condition?.trim()) {
    return { type: "condition", condition: field.condition.trim() };
  }
  if (field.source !== undefined) {
    return { type: "binding", source: field.source };
  }
  if (field.lookup !== undefined) {
    return { type: "lookup", lookup: field.lookup };
  }
  return { type: "input" };
};

/** Clear every inactive legacy sibling while retaining whether a composite
 * format is authored or derived. */
export const templateValueSourcePatch = (
  field: ValueSourceField,
  options: ValueSourceOptions = {},
): ValueSourcePatch => {
  const valueSource = templateValueSourceOf(field, options);
  const isComposite =
    valueSource.type === "composite" || valueSource.type === "composite-draft";
  return {
    valueSource,
    parts: isComposite ? valueSource.parts : undefined,
    // An absent/blank format is derived from the current parts. Do not turn
    // that derivation into an authored string or it stops tracking edits.
    format: isComposite ? field.format : undefined,
    lookup: valueSource.type === "lookup" ? valueSource.lookup : undefined,
    formula: valueSource.type === "formula" ? valueSource.formula : undefined,
    source: valueSource.type === "binding" ? valueSource.source : undefined,
    condition:
      valueSource.type === "condition" ? valueSource.condition : undefined,
    conditionAst:
      valueSource.type === "condition" ? valueSource.conditionAst : undefined,
  };
};

type TemplateValueSourceTransitionOptions = {
  field: ValueSourceField;
  patch: Partial<ValueSourceField>;
  preserveDraft?: boolean;
};

/** Apply an editor patch with the source named by that patch taking priority
 * over stale siblings from the previous branch. */
export const templateValueSourceTransition = ({
  field,
  patch,
  preserveDraft,
}: TemplateValueSourceTransitionOptions): ValueSourcePatch => {
  const next = { ...field, ...patch };
  const options = preserveDraft === undefined ? {} : { preserveDraft };

  if (patch.formula !== undefined) {
    return templateValueSourcePatch(
      {
        ...next,
        parts: undefined,
        format: undefined,
        lookup: undefined,
        source: undefined,
        condition: undefined,
        conditionAst: undefined,
      },
      options,
    );
  }
  if (patch.parts !== undefined) {
    return templateValueSourcePatch(
      {
        ...next,
        lookup: undefined,
        formula: undefined,
        source: undefined,
        condition: undefined,
        conditionAst: undefined,
      },
      options,
    );
  }
  if (patch.lookup !== undefined) {
    return templateValueSourcePatch(
      {
        ...next,
        parts: undefined,
        format: undefined,
        formula: undefined,
        source: undefined,
        condition: undefined,
        conditionAst: undefined,
      },
      options,
    );
  }
  if (patch.source !== undefined) {
    return templateValueSourcePatch(
      {
        ...next,
        parts: undefined,
        format: undefined,
        lookup: undefined,
        formula: undefined,
        condition: undefined,
        conditionAst: undefined,
      },
      options,
    );
  }
  if (patch.condition !== undefined || patch.conditionAst !== undefined) {
    return templateValueSourcePatch(
      {
        ...next,
        parts: undefined,
        format: undefined,
        lookup: undefined,
        formula: undefined,
        source: undefined,
      },
      options,
    );
  }
  return templateValueSourcePatch(next, options);
};
