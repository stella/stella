/**
 * A field's configuration, as the filter chain that declares it.
 *
 * The DOCX is the template, so every surface that configures a field writes the
 * same chain: the api when `configure_template_fields` rewrites a marker, the
 * Studio when it saves the document it just edited. Two writers would be two
 * documents, so the mapping lives here, beside the grammar it writes, and both
 * sides pass their own field object to it.
 *
 * The config type is STRUCTURAL, the way `DeterministicFieldConfig` is: the
 * api's `FieldMeta` and the Studio's session field satisfy it without this
 * package importing either. The catalogue below is total over it, so a
 * property cannot join the shape without a decision about how an author writes
 * it in the document.
 */

import type { FieldDateFormat } from "./field-values.js";
import { assertNever } from "./markers.js";
import type { FilterArgument, FilterCall, FilterName } from "./markers.js";

/** Where a field's value comes from, when a record supplies it. Only the shape
 *  the filters read: each caller's own union satisfies it. */
export type MarkerFieldSource =
  | { kind: "matter"; field: string }
  | { kind: "contact"; field: string }
  | { kind: "firm"; field: string }
  | { kind: "party"; role: string; field: string }
  | { kind: "attorney"; ref: string; field: string };

/** The constraints a chain can express. */
export type MarkerFieldValidation = {
  required?: boolean | undefined;
  pattern?: string | undefined;
  min?: number | undefined;
  max?: number | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
};

/** A registry lookup and the renderings of its one resolved hit. */
export type MarkerFieldLookup = {
  registry: string;
  formats: readonly { key: string; template: string }[];
};

/** The input controls a marker can name. */
export type MarkerFieldInputType =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "select";

/**
 * Everything about a field that a marker's filter chain can carry. A caller's
 * own field type may hold more (a derived condition AST, a discovery count);
 * those keys are simply not read here.
 */
export type MarkerFieldConfig = {
  path: string;
  label?: string | undefined;
  hint?: string | undefined;
  inputType?: MarkerFieldInputType | undefined;
  options?: readonly string[] | undefined;
  optionsFrom?: string | undefined;
  validation?: MarkerFieldValidation | undefined;
  required?: boolean | undefined;
  aiPrompt?: string | undefined;
  aiAdapt?: boolean | undefined;
  aiSeesDocument?: boolean | undefined;
  lookup?: MarkerFieldLookup | undefined;
  source?: MarkerFieldSource | undefined;
  formula?: string | undefined;
  condition?: string | undefined;
  dateFormat?: FieldDateFormat | undefined;
};

/**
 * The filters that describe a REPEAT rather than a value: how many rows it
 * takes and what to call it. These are the ones a `{% for %}` tag may carry,
 * since the loop path names the array, not one of its values.
 */
export const ARRAY_FILTER_NAMES = [
  "label",
  "hint",
  "required",
  "min_items",
  "max_items",
] as const satisfies readonly FilterName[];

export const isArrayFilterName = (name: FilterName): boolean =>
  ARRAY_FILTER_NAMES.some((candidate) => candidate === name);

const NO_FILTERS: FilterCall[] = [];

const filterCall = (
  name: FilterName,
  ...args: FilterArgument[]
): FilterCall => ({ name, args });

const positionalArg = (value: string | number | boolean): FilterArgument => ({
  kind: "positional",
  value,
});

const keywordArg = (
  name: string,
  value: string | number | boolean,
): FilterArgument => ({ kind: "keyword", name, value });

/** The `date()` spec that reads back as this pair: a locale, then the style it
 *  renders with. An ISO date reads the same in every language, so `iso` is
 *  written as the bare style the reader canonicalizes. */
const dateSpec = ({ locale, style }: FieldDateFormat): string =>
  style === "iso" ? style : `${locale}-${style}`;

/** The numeric bounds, in the order the reader lists them, so a chain a
 *  document already carries and one this writes are the same text. */
const VALIDATION_BOUNDS = [
  ["min", "min"],
  ["max", "max"],
  ["minLength", "min_length"],
  ["maxLength", "max_length"],
  ["minItems", "min_items"],
  ["maxItems", "max_items"],
] as const satisfies readonly (readonly [
  keyof MarkerFieldValidation,
  FilterName,
])[];

const writeInputType = (field: MarkerFieldConfig): FilterCall[] => {
  // A date format is what makes a field a date, so it writes the input type:
  // `date("cs-long")` is one filter that says both, and a configuration that
  // named a format without naming the type still round-trips.
  if (field.dateFormat !== undefined) {
    return [filterCall("date", positionalArg(dateSpec(field.dateFormat)))];
  }
  const { inputType } = field;
  if (inputType === undefined) {
    return NO_FILTERS;
  }
  switch (inputType) {
    case "boolean":
      return [filterCall("checkbox")];
    case "date":
      return [filterCall("date", positionalArg("iso"))];
    case "select":
      // A dependent select carries no options of its own: `options_from` says
      // where they come from, and the reader reads the whole chain before it
      // decides whether the field has any.
      return [
        filterCall(
          "select",
          ...(field.options ?? []).map((option) => positionalArg(option)),
        ),
      ];
    case "number":
    case "text":
      // `text` is written even though a marker with no input filter already
      // asks for text: the template check reads an absent input type as a
      // decision nobody made, and a configured field has made it.
      return [filterCall(inputType)];
    default:
      return assertNever(inputType);
  }
};

const writeSource = (field: MarkerFieldConfig): FilterCall[] => {
  const { source } = field;
  if (source === undefined) {
    return NO_FILTERS;
  }
  switch (source.kind) {
    case "party":
      return [
        filterCall(
          "party",
          positionalArg(source.role),
          positionalArg(source.field),
        ),
      ];
    case "attorney":
      return [
        filterCall(
          "attorney",
          positionalArg(source.ref),
          positionalArg(source.field),
        ),
      ];
    case "contact":
    case "firm":
    case "matter":
      return [filterCall(source.kind, positionalArg(source.field))];
    default:
      return assertNever(source);
  }
};

const writeAi = (field: MarkerFieldConfig): FilterCall[] => {
  const { aiAdapt, aiPrompt, aiSeesDocument } = field;
  if (aiPrompt === undefined && aiAdapt !== true) {
    return NO_FILTERS;
  }
  return [
    filterCall(
      "ai",
      ...(aiPrompt === undefined ? [] : [positionalArg(aiPrompt)]),
      ...(aiAdapt === undefined ? [] : [keywordArg("adapt", aiAdapt)]),
      ...(aiSeesDocument === undefined
        ? []
        : [keywordArg("sees_document", aiSeesDocument)]),
    ),
  ];
};

const writeValidation = (field: MarkerFieldConfig): FilterCall[] => {
  const validation = field.validation;
  if (validation === undefined) {
    return NO_FILTERS;
  }
  const calls: FilterCall[] = [];
  if (validation.pattern !== undefined) {
    calls.push(filterCall("pattern", positionalArg(validation.pattern)));
  }
  for (const [key, name] of VALIDATION_BOUNDS) {
    const bound = validation[key];
    if (bound !== undefined) {
      calls.push(filterCall(name, positionalArg(bound)));
    }
  }
  return calls;
};

/** The filter calls one configuration property contributes to a chain. */
type FilterWriter = (field: MarkerFieldConfig) => FilterCall[];

/**
 * Every key of {@link MarkerFieldConfig} and the filters that write it. Total
 * over the shape, so a property cannot join it without a decision about how an
 * author writes it in the document.
 *
 * A filter several properties feed (`ai`, `select`, `date`) is written by one
 * of them and skipped by the rest; the round-trip property in the api's
 * `field-filters.property.test.ts` is what proves nothing is dropped.
 */
const MARKER_FIELD_FILTERS = {
  path: () => NO_FILTERS,
  inputType: writeInputType,
  options: () => NO_FILTERS,
  dateFormat: () => NO_FILTERS,
  optionsFrom: ({ optionsFrom }) =>
    optionsFrom === undefined
      ? NO_FILTERS
      : [filterCall("options_from", positionalArg(optionsFrom))],
  label: ({ label }) =>
    label === undefined
      ? NO_FILTERS
      : [filterCall("label", positionalArg(label))],
  hint: ({ hint }) =>
    hint === undefined ? NO_FILTERS : [filterCall("hint", positionalArg(hint))],
  // The reader writes both the flag and the validation entry, so either one
  // standing alone still comes back as the same field.
  required: (field) =>
    field.required === true || field.validation?.required === true
      ? [filterCall("required")]
      : NO_FILTERS,
  validation: writeValidation,
  aiPrompt: writeAi,
  aiAdapt: () => NO_FILTERS,
  aiSeesDocument: () => NO_FILTERS,
  lookup: ({ lookup }) =>
    lookup === undefined
      ? NO_FILTERS
      : [
          filterCall(
            "lookup",
            positionalArg(lookup.registry),
            ...lookup.formats.map(({ key, template }) =>
              keywordArg(key, template),
            ),
          ),
        ],
  source: writeSource,
  formula: ({ formula }) =>
    formula === undefined
      ? NO_FILTERS
      : [filterCall("formula", positionalArg(formula))],
  condition: ({ condition }) =>
    condition === undefined
      ? NO_FILTERS
      : [filterCall("condition", positionalArg(condition))],
} as const satisfies Record<keyof MarkerFieldConfig, FilterWriter>;

/**
 * The filter chain that declares this field in a document, in the catalogue's
 * own order so a chain the writer produces and one an author wrote read the
 * same.
 */
export const filtersFromFieldConfig = (
  field: MarkerFieldConfig,
): FilterCall[] =>
  Object.values(MARKER_FIELD_FILTERS).flatMap((write) => write(field));

/**
 * The chain a `{% for %}` opener carries for this array: the repeat's own
 * filters and nothing else, derived from {@link ARRAY_FILTER_NAMES}, so a
 * value filter can never be written where the reader refuses it.
 */
export const arrayFiltersFromFieldConfig = (
  field: MarkerFieldConfig,
): FilterCall[] =>
  filtersFromFieldConfig(field).filter(({ name }) => isArrayFilterName(name));
