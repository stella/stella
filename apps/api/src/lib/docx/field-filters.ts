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
 * names the filters that write it (or says why it deliberately has none), and
 * every filter the grammar accepts is named by at least one property. A new
 * manifest key or a new filter is a compile error until someone decides how
 * the two meet.
 */

import * as v from "valibot";

import { assertNever, DATE_FORMAT_STYLES } from "@stll/template-conditions";
import type {
  FilterArgument,
  FilterCall,
  FilterName,
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
  isPlausibleLocale,
  LOOKUP_REGISTRIES,
  type FieldLookupFormat,
  type FieldMeta,
  type FieldValidation,
  type FieldSource,
} from "./types";

// ── The catalogue ────────────────────────────────────────

/** How a manifest property is written: by these filters, or deliberately not
 *  at all. */
type FilterDisposition = { via: readonly FilterName[] } | { excluded: string };

/**
 * Every key of {@link FieldMeta}, and the filters that write it. Total over
 * the manifest shape, so a property added to `fieldMetaSchema` cannot ship
 * without a decision about how an author expresses it in the document.
 */
export const FIELD_META_FILTERS = {
  path: { excluded: "the marker's own path is the field path" },
  label: { via: ["label"] },
  hint: { via: ["hint"] },
  inputType: { via: ["text", "number", "date", "checkbox", "select"] },
  options: { via: ["select"] },
  optionsFrom: { via: ["options_from"] },
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
  required: { via: ["required"] },
  aiPrompt: { via: ["ai"] },
  aiAdapt: { via: ["ai"] },
  aiSeesDocument: { via: ["ai"] },
  lookup: { via: ["lookup"] },
  source: { via: ["matter", "contact", "party", "attorney", "firm"] },
  formula: { via: ["formula"] },
  condition: { via: ["condition"] },
  dateFormat: { via: ["date"] },
  parts: {
    excluded:
      "a composite is written as document text around its part markers, so the format needs no filter",
  },
  format: {
    excluded: "the document text between the part markers is the format",
  },
  conditionAst: {
    excluded: "the canonical AST is derived from `condition` when it is saved",
  },
} as const satisfies Record<keyof FieldMeta, FilterDisposition>;

type CoveredFilter = {
  [TKey in keyof typeof FIELD_META_FILTERS]: (typeof FIELD_META_FILTERS)[TKey] extends {
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
export type FilterIssue = {
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

const applyFilter = (draft: Draft, call: FilterCall): void => {
  switch (call.name) {
    case "text":
    case "number":
    case "select":
      draft.meta["inputType"] = call.name;
      if (call.name === "select") {
        const options = positional(call).filter(
          (value): value is string => typeof value === "string",
        );
        if (options.length === 0) {
          draft.issues.push(
            issue(
              call.name,
              "select() needs the allowed values.",
              'Write select("a", "b").',
            ),
          );
          return;
        }
        draft.meta["options"] = options;
      }
      return;
    case "checkbox":
      draft.meta["inputType"] = "boolean";
      return;
    case "date": {
      draft.meta["inputType"] = "date";
      const spec = stringAt(call, 0);
      if (spec === null) {
        draft.issues.push(
          issue(
            call.name,
            "date() needs a locale and a style.",
            `Write date("pl-long"); the styles are ${quoted(DATE_FORMAT_STYLES)}.`,
          ),
        );
        return;
      }
      const cut = spec.lastIndexOf("-");
      const locale = cut === -1 ? "" : spec.slice(0, cut);
      const style = cut === -1 ? spec : spec.slice(cut + 1);
      if (
        !isOneOf(DATE_FORMAT_STYLES, style) ||
        locale === "" ||
        !isPlausibleLocale(locale)
      ) {
        draft.issues.push(
          issue(
            call.name,
            `date("${spec}") is not a locale and a style.`,
            `Write date("pl-long"); the styles are ${quoted(DATE_FORMAT_STYLES)}.`,
          ),
        );
        return;
      }
      draft.meta["dateFormat"] = { locale, style };
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
