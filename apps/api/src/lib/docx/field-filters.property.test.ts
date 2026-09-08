/**
 * The reader and the writer of a marker's filter chain are one round trip.
 *
 * A configure call now rewrites the document, so a field that does not come
 * back from its own chain is a field the call silently changed. The property
 * below is that guard over the whole manifest shape rather than over the
 * handful of chains someone thought to write down.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";
import {
  classifyMarker,
  filtersFromFieldConfig,
  renderValueMarker,
} from "@stll/template-conditions";

import {
  ATTORNEY_REFS,
  CONTACT_FIELDS,
  FIRM_FIELDS,
  MATTER_FIELDS,
  USER_FIELDS,
  WORKSPACE_CONTACT_ROLES,
} from "@/api/lib/template-binding/binding-sources";

import { fieldMetaFromFilters } from "./field-filters";
import {
  DATE_FORMAT_STYLES,
  isFieldMeta,
  LOOKUP_REGISTRIES,
  SMALLEST_MAXIMUM,
  type FieldMeta,
} from "./types";

// Text an author or an agent puts in a label, a hint or a prompt. Quotes,
// backslashes and the chain's own punctuation are what the escaping has to
// survive; braces are excluded because the grammar reserves them and the
// configure boundary refuses them by name.
const text = fc.stringMatching(/^[- ,.|()'"\\a-zA-Zá-ž0-9]{1,20}$/u);

const upperBound = fc.integer({ min: SMALLEST_MAXIMUM, max: 9999 });

const validation = fc.record(
  {
    pattern: fc.constantFrom("^[0-9]{2}$", "^[A-Z].*$"),
    min: fc.integer({ min: -100, max: 100 }),
    max: upperBound,
    minLength: fc.integer({ min: 0, max: 40 }),
    maxLength: upperBound,
    minItems: fc.integer({ min: 0, max: 9 }),
    maxItems: upperBound,
  },
  { requiredKeys: [] },
);

/** The input control and the properties only that control carries, so a field
 *  never claims options it has no select to hold them. */
const control = fc.oneof(
  fc.constant({}),
  fc.constant({ inputType: "text" as const }),
  fc.constant({ inputType: "number" as const }),
  fc.constant({ inputType: "boolean" as const }),
  fc
    .uniqueArray(text, { minLength: 1, maxLength: 3 })
    .map((options) => ({ inputType: "select" as const, options })),
  fc
    .tuple(
      fc.constantFrom("cs", "pl-PL", "en-GB"),
      fc.constantFrom(...DATE_FORMAT_STYLES),
    )
    .map(([locale, style]) => ({
      inputType: "date" as const,
      dateFormat: { locale, style },
    })),
);

const source = fc.oneof(
  fc
    .constantFrom(...MATTER_FIELDS)
    .map((field) => ({ kind: "matter" as const, field })),
  fc
    .constantFrom(...CONTACT_FIELDS)
    .map((field) => ({ kind: "contact" as const, field })),
  fc
    .constantFrom(...FIRM_FIELDS)
    .map((field) => ({ kind: "firm" as const, field })),
  fc
    .tuple(
      fc.constantFrom(...WORKSPACE_CONTACT_ROLES),
      fc.constantFrom(...CONTACT_FIELDS),
    )
    .map(([role, field]) => ({ kind: "party" as const, role, field })),
  fc
    .tuple(fc.constantFrom(...ATTORNEY_REFS), fc.constantFrom(...USER_FIELDS))
    .map(([ref, field]) => ({ kind: "attorney" as const, ref, field })),
);

const lookup = fc
  .tuple(
    fc.constantFrom(...LOOKUP_REGISTRIES),
    fc.array(
      fc
        .tuple(fc.constantFrom("full", "short", "address", "ico"), text)
        .map(([key, template]) => ({ key, template })),
      { minLength: 1, maxLength: 3 },
    ),
  )
  .map(([registry, formats]) => ({
    registry,
    // Formats are keyed, so two entries under one key are one entry.
    formats: [
      ...new Map(formats.map((format) => [format.key, format])).values(),
    ],
  }));

/** Exactly one answer to "who fills this field", which is all the manifest
 *  schema admits: the branches are mutually exclusive by construction. */
const filledBy = fc.oneof(
  fc.constant({}),
  text.map((aiPrompt) => ({ aiPrompt })),
  fc.constant({ aiAdapt: true }),
  fc
    .tuple(text, fc.boolean())
    .map(([aiPrompt, aiSeesDocument]) => ({ aiPrompt, aiSeesDocument })),
  lookup.map((value) => ({ lookup: value })),
  source.map((value) => ({ source: value })),
  fc.constantFrom("deposit * 12", "a + b").map((formula) => ({ formula })),
  fc
    .constantFrom("kind == 'company'", "count > 2")
    .map((condition) => ({ condition })),
);

const described = fc.record(
  {
    path: fc.constantFrom("deposit", "tenant.name", "fee_2"),
    label: text,
    hint: text,
    optionsFrom: fc.constantFrom("company_type", "kind"),
    required: fc.constant(true),
    validation,
  },
  { requiredKeys: ["path"] },
);

/** One field from its three independent halves: what it is called, what
 *  control it uses, and who fills it. */
const composeField = ([base, inputControl, who]: [
  object,
  object,
  object,
]): object => ({ ...base, ...inputControl, ...who });

const field: fc.Arbitrary<FieldMeta> = fc
  .tuple(described, control, filledBy)
  .map(composeField)
  .filter(isFieldMeta);

/**
 * The field as a document can say it. Two spellings of one configuration are
 * one field, so the round trip compares against the spelling the document
 * holds rather than the one the caller happened to send:
 *
 * - `required` is both the flag and the validation entry, because `required`
 *   is one filter;
 * - an ISO date reads the same in every language, so `date("iso")` carries the
 *   one locale that never reaches a rendered date.
 */
const asDocumentSaysIt = (original: FieldMeta): FieldMeta => {
  const withDate =
    original.dateFormat?.style === "iso"
      ? { ...original, dateFormat: { locale: "en", style: "iso" as const } }
      : original;
  return withDate.required === true
    ? { ...withDate, validation: { ...withDate.validation, required: true } }
    : withDate;
};

describe("a field and its filter chain are one round trip", () => {
  test("the chain a field writes reads back as that field", () => {
    fc.assert(
      fc.property(field, (original) => {
        const filters = filtersFromFieldConfig(original);
        fc.pre(filters.length > 0);
        const { field: readBack, issues } = fieldMetaFromFilters(
          original.path,
          filters,
        );
        expect(issues).toEqual([]);
        expect(readBack).toEqual(asDocumentSaysIt(original));
      }),
      propertyConfig(),
    );
  });

  test("the chain survives the marker text it is written into", () => {
    fc.assert(
      fc.property(field, (original) => {
        const filters = filtersFromFieldConfig(original);
        fc.pre(filters.length > 0);
        const marker = renderValueMarker(original.path, filters);
        expect(classifyMarker(marker.slice(2, -2), "output")).toEqual({
          kind: "placeholder",
          expr: original.path,
          filters,
        });
      }),
      propertyConfig(),
    );
  });

  test("a field the document already declares is a fixed point of the writer", () => {
    fc.assert(
      fc.property(field, (original) => {
        const once = filtersFromFieldConfig(original);
        fc.pre(once.length > 0);
        const readBack = fieldMetaFromFilters(original.path, once).field;
        expect(readBack).not.toBeNull();
        expect(filtersFromFieldConfig(readBack ?? original)).toEqual(once);
      }),
      propertyConfig(),
    );
  });
});
