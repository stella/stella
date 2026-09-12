/**
 * Field configuration written in the marker.
 *
 * A value marker's filter chain IS its configuration:
 * `{{ deposit | number | label("Kaution") | required }}` says what the field
 * is, what to call it and whether it must be answered. Discovery therefore
 * yields a complete manifest from the document bytes, with no second store to
 * keep in step.
 *
 * The catalogue below is total in both directions: every manifest property
 * names the filters that carry it (or says why it deliberately has none), and
 * every filter the grammar accepts is named by at least one property. A new
 * manifest key or a new filter is a compile error until someone decides how
 * the two meet.
 *
 * The chain itself is WRITTEN by `filtersFromFieldConfig` in
 * `@stll/template-conditions`, which the Studio writes through too; this
 * module owns reading one back into the manifest shape.
 */

import * as v from "valibot";

import {
  DATE_FORMAT_SPEC_HINT,
  normalizeDateFormatSpec,
} from "@stll/agent-input";
import {
  ARRAY_FILTER_NAMES,
  assertNever,
  isArrayFilterName,
} from "@stll/template-conditions";
import type {
  FilterArgument,
  FilterCall,
  FilterName,
  MarkerFieldConfig,
  MarkerLiteral,
} from "@stll/template-conditions";

import {
  ATTORNEY_REFS,
  CONTACT_FIELDS,
  FIRM_FIELDS,
  MATTER_FIELDS,
  USER_FIELDS,
  WORKSPACE_CONTACT_ROLES,
} from "@/api/lib/template-binding/binding-sources";

import {
  fieldMetaSchema,
  LOOKUP_REGISTRIES,
  SMALLEST_MAXIMUM,
  type FieldLookupFormat,
  type FieldMeta,
  type FieldValidation,
  type FieldSource,
} from "./types";

// ── The catalogue ────────────────────────────────────────

/** How a manifest property reaches a marker: through these filters, or
 *  deliberately not at all. */
type FilterDisposition = { via: readonly FilterName[] } | { excluded: string };

/**
 * Every key of {@link FieldMeta} and the filters that carry it. Total over the
 * manifest shape, so a property added to `fieldMetaSchema` cannot ship without
 * a decision about how an author expresses it in the document.
 *
 * The code that WRITES a chain lives in `@stll/template-conditions`, beside
 * the grammar, because the Studio writes the same chains when it saves a
 * document; the assertions below pin this list to the shape that writer
 * covers, so neither side can gain a property the other has not decided.
 */
export const FIELD_META_FILTERS = {
  path: { excluded: "the marker's own path is the field path" },
  inputType: { via: ["text", "number", "date", "checkbox", "select"] },
  options: { via: ["select"] },
  dateFormat: { via: ["date"] },
  optionsFrom: { via: ["options_from"] },
  label: { via: ["label"] },
  hint: { via: ["hint"] },
  required: { via: ["required"] },
  validation: {
    via: [
      "required",
      "pattern",
      "min",
      "max",
      "min_length",
      "max_length",
      "min_items",
      "max_items",
    ],
  },
  aiPrompt: { via: ["ai"] },
  aiAdapt: { via: ["ai"] },
  aiSeesDocument: { via: ["ai"] },
  lookup: { via: ["lookup"] },
  source: { via: ["matter", "contact", "party", "attorney", "firm"] },
  formula: { via: ["formula"] },
  condition: { via: ["condition"] },
  conditionAst: {
    excluded: "the canonical AST is derived from `condition` when it is saved",
  },
} as const satisfies Record<keyof FieldMeta, FilterDisposition>;

/** The manifest keys a marker actually carries: everything the catalogue does
 *  not deliberately exclude. */
type WrittenFieldMetaKey = {
  [
    TKey in keyof typeof FIELD_META_FILTERS
  ]: (typeof FIELD_META_FILTERS)[TKey] extends {
    via: readonly FilterName[];
  }
    ? TKey
    : never;
}[keyof typeof FIELD_META_FILTERS];

// The shared writer's shape and this catalogue describe the same field. A key
// on either side the other does not know about would be a configuration one
// surface writes and the other silently drops.
true satisfies Exclude<
  WrittenFieldMetaKey,
  keyof MarkerFieldConfig
> extends never
  ? true
  : never;
true satisfies Exclude<keyof MarkerFieldConfig, keyof FieldMeta> extends never
  ? true
  : never;
true satisfies FieldMeta extends MarkerFieldConfig ? true : never;

type CoveredFilter = {
  [
    TKey in keyof typeof FIELD_META_FILTERS
  ]: (typeof FIELD_META_FILTERS)[TKey] extends {
    via: readonly (infer TFilter)[];
  }
    ? TFilter
    : never;
}[keyof typeof FIELD_META_FILTERS];

type UncoveredFilter = Exclude<FilterName, CoveredFilter>;

// Total the other way too: a filter the grammar accepts but no manifest
// property claims would parse and then quietly configure nothing.
true satisfies UncoveredFilter extends never ? true : never;

// ── Rejections ───────────────────────────────────────────

/** One filter the author wrote that this marker cannot act on. */
type FilterIssue = {
  filter: FilterName;
  message: string;
  hint: string;
};

const issue = (
  filter: FilterName,
  message: string,
  hint: string,
): FilterIssue => ({ filter, message, hint });

// ── Argument readers ─────────────────────────────────────

const positional = (call: FilterCall): MarkerLiteral[] =>
  call.args.flatMap((arg) => (arg.kind === "positional" ? [arg.value] : []));

const keywords = (call: FilterCall): { name: string; value: MarkerLiteral }[] =>
  call.args.flatMap((arg: FilterArgument) =>
    arg.kind === "keyword" ? [{ name: arg.name, value: arg.value }] : [],
  );

const stringAt = (call: FilterCall, index: number): string | null => {
  const value = positional(call).at(index);
  return typeof value === "string" ? value : null;
};

const numberAt = (call: FilterCall, index: number): number | null => {
  const value = positional(call).at(index);
  return typeof value === "number" ? value : null;
};

const booleanKeyword = (
  call: FilterCall,
  name: string,
): boolean | undefined => {
  const found = keywords(call).find((entry) => entry.name === name);
  return typeof found?.value === "boolean" ? found.value : undefined;
};

const quoted = (values: readonly string[]): string =>
  values.map((value) => `"${value}"`).join(", ");

/** Narrow a filter argument to one of a closed set, so a binding kind or a
 *  registry slug reaches the manifest as its own union rather than a cast. */
const isOneOf = <TValue extends string>(
  values: readonly TValue[],
  candidate: unknown,
): candidate is TValue =>
  typeof candidate === "string" && values.some((value) => value === candidate);

// ── Filter application ───────────────────────────────────

/** The manifest a marker's filter chain builds, plus what it could not act on. */
export type FieldFilterResult = {
  /** `null` when the chain configured nothing (an empty chain, or every step
   *  rejected). */
  field: FieldMeta | null;
  issues: FilterIssue[];
};

type Draft = {
  meta: Record<string, unknown>;
  validation: FieldValidation;
  issues: FilterIssue[];
};

const applyNumericValidation = (
  draft: Draft,
  call: FilterCall,
  key: "min" | "max" | "minLength" | "maxLength" | "minItems" | "maxItems",
): void => {
  const value = numberAt(call, 0);
  if (value === null) {
    draft.issues.push(
      issue(
        call.name,
        `${call.name}() needs one number.`,
        `Write ${call.name}(3).`,
      ),
    );
    return;
  }
  // The wire schema refuses a maximum below 1, so the marker has to as well or
  // a DOCX becomes the one way to save a field nobody can fill. The minimums
  // and `max` keep taking 0: a bound of 0 is a real one.
  if ((key === "maxLength" || key === "maxItems") && value < SMALLEST_MAXIMUM) {
    draft.issues.push(
      issue(
        call.name,
        `${call.name}(${value}) admits nothing.`,
        `A maximum is at least ${SMALLEST_MAXIMUM}; drop the filter to leave ` +
          "the count open.",
      ),
    );
    return;
  }
  draft.validation[key] = value;
};

const applySource = (
  draft: Draft,
  call: FilterCall,
  source: FieldSource | null,
  hint: string,
): void => {
  if (source === null) {
    draft.issues.push(
      issue(call.name, `${call.name}() names no known field.`, hint),
    );
    return;
  }
  draft.meta["source"] = source;
};

const contactField = (value: string | null): FieldSource | null =>
  isOneOf(CONTACT_FIELDS, value) ? { kind: "contact", field: value } : null;

/** The filters that constrain a value rather than describe it. Split from the
 *  main switch so each half stays readable. */
type ValidationFilter =
  | "required"
  | "pattern"
  | "min"
  | "max"
  | "min_length"
  | "max_length"
  | "min_items"
  | "max_items";

const applyValidationFilter = (
  draft: Draft,
  call: FilterCall,
  name: ValidationFilter,
): void => {
  switch (name) {
    case "required":
      draft.meta["required"] = true;
      draft.validation.required = true;
      return;
    case "pattern": {
      const pattern = stringAt(call, 0);
      if (pattern === null) {
        draft.issues.push(
          issue(
            call.name,
            "pattern() needs the regular expression the whole value must match.",
            'Write pattern("^[0-9]{10}$").',
          ),
        );
        return;
      }
      draft.validation.pattern = pattern;
      return;
    }
    case "min":
      applyNumericValidation(draft, call, "min");
      return;
    case "max":
      applyNumericValidation(draft, call, "max");
      return;
    case "min_length":
      applyNumericValidation(draft, call, "minLength");
      return;
    case "max_length":
      applyNumericValidation(draft, call, "maxLength");
      return;
    case "min_items":
      applyNumericValidation(draft, call, "minItems");
      return;
    case "max_items":
      applyNumericValidation(draft, call, "maxItems");
      return;
    default:
      return assertNever(name);
  }
};

/** The filters that bind a field to a record in the matter, one per binding
 *  kind. Split from the main switch so each half stays readable. */
type BindingFilter = "matter" | "contact" | "party" | "attorney" | "firm";

const applyBindingFilter = (
  draft: Draft,
  call: FilterCall,
  name: BindingFilter,
): void => {
  switch (name) {
    case "matter": {
      const field = stringAt(call, 0);
      applySource(
        draft,
        call,
        isOneOf(MATTER_FIELDS, field) ? { kind: "matter", field } : null,
        `The matter fields are ${quoted(MATTER_FIELDS)}.`,
      );
      return;
    }
    case "contact": {
      applySource(
        draft,
        call,
        contactField(stringAt(call, 0)),
        `The contact fields are ${quoted(CONTACT_FIELDS)}.`,
      );
      return;
    }
    case "party": {
      const role = stringAt(call, 0);
      const field = stringAt(call, 1);
      applySource(
        draft,
        call,
        isOneOf(WORKSPACE_CONTACT_ROLES, role) && isOneOf(CONTACT_FIELDS, field)
          ? { kind: "party", role, field }
          : null,
        `Write party(role, field): the roles are ${quoted(WORKSPACE_CONTACT_ROLES)} and the fields are ${quoted(CONTACT_FIELDS)}.`,
      );
      return;
    }
    case "attorney": {
      const ref = stringAt(call, 0);
      const field = stringAt(call, 1);
      applySource(
        draft,
        call,
        isOneOf(ATTORNEY_REFS, ref) && isOneOf(USER_FIELDS, field)
          ? { kind: "attorney", ref, field }
          : null,
        `Write attorney(ref, field): the refs are ${quoted(ATTORNEY_REFS)} and the fields are ${quoted(USER_FIELDS)}.`,
      );
      return;
    }
    case "firm": {
      const field = stringAt(call, 0);
      applySource(
        draft,
        call,
        isOneOf(FIRM_FIELDS, field) ? { kind: "firm", field } : null,
        `The firm fields are ${quoted(FIRM_FIELDS)}.`,
      );
      return;
    }
    default:
      return assertNever(name);
  }
};

const applyFilter = (draft: Draft, call: FilterCall): void => {
  switch (call.name) {
    case "text":
    case "number":
    case "select": {
      draft.meta["inputType"] = call.name;
      if (call.name !== "select") {
        return;
      }
      const options = positional(call).filter(
        (value): value is string => typeof value === "string",
      );
      if (options.length > 0) {
        draft.meta["options"] = options;
      }
      return;
    }
    case "checkbox":
      draft.meta["inputType"] = "boolean";
      return;
    case "date": {
      draft.meta["inputType"] = "date";
      const spec = positional(call).at(0);
      if (spec === undefined) {
        draft.issues.push(
          issue(call.name, "date() needs a locale.", DATE_FORMAT_SPEC_HINT),
        );
        return;
      }
      const dateFormat = normalizeDateFormatSpec(spec);
      if (!dateFormat.ok) {
        draft.issues.push(
          issue(
            call.name,
            `date(${dateFormat.received}) is not ${dateFormat.expected}.`,
            dateFormat.hint,
          ),
        );
        return;
      }
      draft.meta["dateFormat"] = dateFormat.value;
      return;
    }
    case "options_from": {
      const source = stringAt(call, 0);
      if (source === null) {
        draft.issues.push(
          issue(
            call.name,
            "options_from() needs the field path its options come from.",
            'Write options_from("company_type").',
          ),
        );
        return;
      }
      draft.meta["optionsFrom"] = source;
      return;
    }
    case "label":
    case "hint": {
      const text = stringAt(call, 0);
      if (text === null) {
        draft.issues.push(
          issue(
            call.name,
            `${call.name}() needs the text to show.`,
            `Write ${call.name}("Deposit").`,
          ),
        );
        return;
      }
      draft.meta[call.name] = text;
      return;
    }
    case "required":
    case "pattern":
    case "min":
    case "max":
    case "min_length":
    case "max_length":
    case "min_items":
    case "max_items":
      applyValidationFilter(draft, call, call.name);
      return;
    case "ai": {
      const prompt = stringAt(call, 0);
      const adapt = booleanKeyword(call, "adapt");
      const seesDocument = booleanKeyword(call, "sees_document");
      if (prompt === null && adapt !== true) {
        draft.issues.push(
          issue(
            call.name,
            "ai() needs a drafting instruction, or adapt=true to let AI rewrite what a person entered.",
            'Write ai("Summarize the dispute in two sentences") or ai(adapt=true).',
          ),
        );
        return;
      }
      if (prompt !== null) {
        draft.meta["aiPrompt"] = prompt;
      }
      if (adapt !== undefined) {
        draft.meta["aiAdapt"] = adapt;
      }
      if (seesDocument !== undefined) {
        draft.meta["aiSeesDocument"] = seesDocument;
      }
      return;
    }
    case "lookup": {
      const registry = stringAt(call, 0);
      const formats: FieldLookupFormat[] = keywords(call).flatMap(
        ({ name, value }) =>
          typeof value === "string" ? [{ key: name, template: value }] : [],
      );
      if (!isOneOf(LOOKUP_REGISTRIES, registry)) {
        draft.issues.push(
          issue(
            call.name,
            `lookup(${registry === null ? "" : `"${registry}"`}) names no business registry.`,
            `The registries are ${quoted(LOOKUP_REGISTRIES)}.`,
          ),
        );
        return;
      }
      if (formats.length === 0) {
        draft.issues.push(
          issue(
            call.name,
            "lookup() needs at least one named rendering of the registry hit.",
            'Write lookup("krs", full="[name], [street], [city]"); the first named rendering is what a bare marker prints.',
          ),
        );
        return;
      }
      draft.meta["lookup"] = { registry, formats };
      return;
    }
    case "matter":
    case "contact":
    case "party":
    case "attorney":
    case "firm":
      applyBindingFilter(draft, call, call.name);
      return;
    case "formula":
    case "condition": {
      const expression = stringAt(call, 0);
      if (expression === null) {
        draft.issues.push(
          issue(
            call.name,
            `${call.name}() needs the expression as a quoted string.`,
            call.name === "formula"
              ? 'Write formula("base_rent * 12").'
              : "Write condition(\"company_type == 'company'\").",
          ),
        );
        return;
      }
      draft.meta[call.name] = expression;
      return;
    }
    default:
      return assertNever(call.name);
  }
};

/**
 * The manifest field one marker's filter chain declares. An empty chain
 * declares nothing (the marker is a plain text input, exactly as before), and
 * a chain whose result the manifest schema refuses is reported rather than
 * half-applied.
 */
export const fieldMetaFromFilters = (
  path: string,
  filters: readonly FilterCall[],
): FieldFilterResult => {
  if (filters.length === 0) {
    return { field: null, issues: [] };
  }
  const draft: Draft = { meta: { path }, validation: {}, issues: [] };
  for (const call of filters) {
    applyFilter(draft, call);
  }
  if (Object.keys(draft.validation).length > 0) {
    draft.meta["validation"] = draft.validation;
  }
  if (Object.keys(draft.meta).length === 1) {
    // Every step was rejected, so the marker configures nothing beyond its own
    // path: report the rejections and leave the field to plain discovery.
    return { field: null, issues: draft.issues };
  }

  // A select's options come from the filter or from another field, and the
  // whole chain decides which: `select() | options_from("kind")` is a dependent
  // select, `select()` alone is a list nobody can pick from. The check waits
  // for the chain to finish, so the order the author wrote the two in cannot
  // change the answer.
  if (
    draft.meta["inputType"] === "select" &&
    draft.meta["options"] === undefined &&
    draft.meta["optionsFrom"] === undefined
  ) {
    return {
      field: null,
      issues: [
        ...draft.issues,
        issue(
          "select",
          "select() offers no values to pick from.",
          'Write select("a", "b"), or options_from("other_field") to take them from another field.',
        ),
      ],
    };
  }

  const parsed = v.safeParse(fieldMetaSchema, draft.meta);
  if (!parsed.success) {
    const first = parsed.issues.at(0);
    return {
      field: null,
      issues: [
        ...draft.issues,
        {
          filter: filters[0]?.name ?? "text",
          message: `The filters on {{ ${path} }} do not describe one field: ${first?.message ?? "invalid configuration"}.`,
          hint: "Keep one of the filters that decide who fills the field: ai(), lookup(), formula(), condition(), or a matter/contact/party/attorney/firm binding.",
        },
      ],
    };
  }
  return { field: parsed.output, issues: draft.issues };
};

/**
 * The manifest field a loop's own filters declare. A value filter on a loop
 * path configures nothing — there is no single value there — so it is reported
 * against the set that does apply, and the rest of the chain still lands.
 */
export const arrayFieldFromFilters = (
  path: string,
  filters: readonly FilterCall[],
): FieldFilterResult => {
  const applicable = filters.filter(({ name }) => isArrayFilterName(name));
  const issues = filters
    .filter(({ name }) => !isArrayFilterName(name))
    .map(({ name }) =>
      issue(
        name,
        `${name}() configures a value, and {% for ${path} %} names the repeat itself.`,
        `On a loop the filters are ${ARRAY_FILTER_NAMES.join(", ")}; put a value filter on the item's own marker.`,
      ),
    );
  const applied = fieldMetaFromFilters(path, applicable);
  return { field: applied.field, issues: [...issues, ...applied.issues] };
};

// ── Item counts ──────────────────────────────────────────

/** The constraints that count a repeat's rows rather than describe one value.
 *  Named against the validation shape, so renaming one is a compile error. */
const ITEM_COUNT_KEYS = [
  "minItems",
  "maxItems",
] as const satisfies readonly (keyof FieldValidation)[];

/** The item counts a validation carries, or `null` when it carries none. */
const itemCounts = (
  validation: FieldValidation | undefined,
): FieldValidation | null => {
  if (validation === undefined) {
    return null;
  }
  const counts = Object.fromEntries(
    ITEM_COUNT_KEYS.flatMap((key) =>
      validation[key] === undefined ? [] : [[key, validation[key]]],
    ),
  );
  return Object.keys(counts).length === 0 ? null : counts;
};

/** The same field with the item counts taken off it, and `validation` gone
 *  when they were all it held. */
const withoutItemCounts = (field: FieldMeta): FieldMeta => {
  const {
    minItems: _minItems,
    maxItems: _maxItems,
    ...rest
  } = field.validation ?? {};
  const { validation: _validation, ...withoutValidation } = field;
  return Object.keys(rest).length === 0
    ? withoutValidation
    : { ...withoutValidation, validation: rest };
};

/** The array a path repeats within: the longest declared array path it sits
 *  under, so an item of a nested loop lands on the inner repeat. */
const arrayOfItemPath = (
  path: string,
  arrayPaths: ReadonlySet<string>,
): string | null => {
  let owner: string | null = null;
  for (const arrayPath of arrayPaths) {
    if (
      path.startsWith(`${arrayPath}.`) &&
      (owner === null || arrayPath.length > owner.length)
    ) {
      owner = arrayPath;
    }
  }
  return owner;
};

export type ItemCountFold = {
  fields: FieldMeta[];
  /** Every constraint that moved, from the item path that carried it to the
   *  array that now does, so a caller with per-entry positions can still
   *  address the entry it came from. */
  moves: { from: string; to: string }[];
};

/**
 * Move an item-count constraint onto the repeat it counts.
 *
 * `min_items(3)` on `attorneys.name` says the loop takes three rows, not that
 * one attorney's name holds three values, and read as the latter it refuses
 * every fill: the item field never carries a list. The array is the one place
 * the constraint means something, so it moves there, creating the array's
 * field when the caller configured only its items. The array's own count
 * wins: it is the constraint written where it belongs.
 */
export const foldItemCountConstraints = (
  fields: readonly FieldMeta[],
  arrayPaths: ReadonlySet<string>,
): ItemCountFold => {
  const byPath = new Map(fields.map((field) => [field.path, field]));
  const order = [...byPath.keys()];
  const moves: { from: string; to: string }[] = [];
  for (const field of fields) {
    const counts = itemCounts(field.validation);
    const arrayPath =
      counts === null ? null : arrayOfItemPath(field.path, arrayPaths);
    if (counts === null || arrayPath === null) {
      continue;
    }
    byPath.set(field.path, withoutItemCounts(field));
    const array = byPath.get(arrayPath) ?? { path: arrayPath };
    byPath.set(arrayPath, {
      ...array,
      validation: { ...counts, ...array.validation },
    });
    if (!order.includes(arrayPath)) {
      order.push(arrayPath);
    }
    moves.push({ from: field.path, to: arrayPath });
  }
  return {
    fields: order.flatMap((path) => {
      const field = byPath.get(path);
      return field === undefined ? [] : [field];
    }),
    moves,
  };
};

/** A stable rendering of one chain, so two occurrences of a path can be
 *  compared for agreement without caring about whitespace. */
export const filterChainSignature = (filters: readonly FilterCall[]): string =>
  filters
    .map(
      ({ args, name }) =>
        `${name}(${args
          .map((arg) =>
            arg.kind === "positional"
              ? JSON.stringify(arg.value)
              : `${arg.name}=${JSON.stringify(arg.value)}`,
          )
          .join(",")})`,
    )
    .join("|");
