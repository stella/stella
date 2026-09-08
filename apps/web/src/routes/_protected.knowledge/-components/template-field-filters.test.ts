import { describe, expect, test } from "bun:test";

import { filtersFromFieldConfig, scanMarkers } from "@stll/template-conditions";

import {
  markerConfigRewrites,
  unwritableFieldValues,
} from "@/routes/_protected.knowledge/-components/template-field-filters";
import { formatMarker } from "@/routes/_protected.knowledge/-components/template-markers";
import { studioFieldToManifestField } from "@/routes/_protected.knowledge/-components/template-studio-model";
import {
  defaultStudioField,
  type StudioField,
} from "@/routes/_protected.knowledge/-components/template-studio-store";

const fieldFilters = (field: StudioField) =>
  filtersFromFieldConfig(studioFieldToManifestField(field));

const studioField = (patch: Partial<StudioField>): StudioField => ({
  ...defaultStudioField(patch.path ?? "field"),
  ...patch,
});

/**
 * One configured field and the marker text it declares itself with. The chain
 * comes from the shared writer, so this table is about the other half: that a
 * session field reaches that writer as the configuration the author entered,
 * and that the text it produces is what the scanner reads back.
 */
const CONFIGURED_FIELDS = [
  [
    studioField({
      path: "note",
      label: "Note",
      hint: "One line",
      required: true,
    }),
    '{{ note | text | label("Note") | hint("One line") | required }}',
  ],
  [studioField({ path: "rent", inputType: "number" }), "{{ rent | number }}"],
  [
    studioField({
      path: "signed_on",
      inputType: "date",
      dateFormat: { locale: "cs", style: "long" },
    }),
    '{{ signed_on | date("cs-long") }}',
  ],
  [
    studioField({ path: "due_on", inputType: "date" }),
    '{{ due_on | date("iso") }}',
  ],
  [
    studioField({
      path: "company_type",
      inputType: "select",
      options: ["company", "person"],
    }),
    '{{ company_type | select("company", "person") }}',
  ],
  [
    studioField({
      path: "role",
      inputType: "select",
      options: ["a"],
      optionsFrom: "company_type",
    }),
    '{{ role | select("a") | options_from("company_type") }}',
  ],
  [
    studioField({
      path: "deposit",
      inputType: "number",
      validation: { min: 0, max: 10, required: true },
    }),
    "{{ deposit | number | required | min(0) | max(10) }}",
  ],
  [
    studioField({
      path: "reference",
      validation: { pattern: "^[0-9]+$", minLength: 2, maxLength: 8 },
    }),
    '{{ reference | text | pattern("^[0-9]+$") | min_length(2) | max_length(8) }}',
  ],
  [
    studioField({
      path: "attendees",
      validation: { minItems: 1, maxItems: 5 },
    }),
    "{{ attendees | text | min_items(1) | max_items(5) }}",
  ],
  [
    studioField({
      path: "summary",
      aiPrompt: "Summarize the dispute.",
      aiSeesDocument: true,
    }),
    '{{ summary | text | ai("Summarize the dispute.", sees_document=true) }}',
  ],
  [
    studioField({ path: "party_name", aiAdapt: true }),
    "{{ party_name | text | ai(adapt=true) }}",
  ],
  [
    studioField({
      path: "buyer",
      lookup: {
        registry: "companies-house",
        formats: [{ key: "full", template: "[name], [city]" }],
      },
      valueSource: {
        type: "lookup",
        lookup: {
          registry: "companies-house",
          formats: [{ key: "full", template: "[name], [city]" }],
        },
      },
    }),
    '{{ buyer | text | lookup("companies-house", full="[name], [city]") }}',
  ],
  [
    studioField({
      path: "matter_title",
      source: { kind: "matter", field: "name" },
      valueSource: {
        type: "binding",
        source: { kind: "matter", field: "name" },
      },
    }),
    '{{ matter_title | text | matter("name") }}',
  ],
  [
    studioField({
      path: "tenant_email",
      source: { kind: "party", role: "opposing_party", field: "email" },
      valueSource: {
        type: "binding",
        source: { kind: "party", role: "opposing_party", field: "email" },
      },
    }),
    '{{ tenant_email | text | party("opposing_party", "email") }}',
  ],
  [
    studioField({
      path: "total",
      formula: "rent * 12",
      valueSource: { type: "formula", formula: "rent * 12" },
    }),
    '{{ total | text | formula("rent * 12") }}',
  ],
  [
    studioField({
      path: "is_company",
      inputType: "boolean",
      condition: "company_type == 'company'",
      valueSource: {
        type: "condition",
        condition: "company_type == 'company'",
      },
    }),
    "{{ is_company | checkbox | condition(\"company_type == 'company'\") }}",
  ],
] as const satisfies readonly (readonly [StudioField, string])[];

const asMarker = (field: StudioField): string =>
  formatMarker({
    kind: "placeholder",
    expr: field.path,
    filters: fieldFilters(field),
  });

describe("field configuration as a filter chain", () => {
  test.each(
    CONFIGURED_FIELDS.map(
      ([field, marker]) => [field.path, field, marker] as const,
    ),
  )("%s declares itself in the document", (_path, field, marker) => {
    expect(asMarker(field)).toBe(marker);
  });

  test.each(CONFIGURED_FIELDS.map(([field]) => [field.path, field] as const))(
    "%s is read back by the scanner as the chain it was written from",
    (_path, field) => {
      const scanned = scanMarkers(asMarker(field)).at(0);
      expect(scanned?.meta).toEqual({
        kind: "placeholder",
        expr: field.path,
        filters: fieldFilters(field),
      });
    },
  );

  test("a field with nothing configured still names its input type", () => {
    expect(asMarker(defaultStudioField("plain"))).toBe("{{ plain | text }}");
  });

  test("reports a value the marker grammar cannot spell", () => {
    expect(
      unwritableFieldValues([studioField({ path: "fee", label: "a { b" })]),
    ).toEqual([{ path: "fee", filter: "label" }]);
    expect(
      unwritableFieldValues(CONFIGURED_FIELDS.map(([field]) => field)),
    ).toEqual([]);
  });
});

describe("writing the session into the document", () => {
  /** A document of markers, with the ranges the directive scan reports. */
  const documentWith = (markers: readonly string[]) => {
    const directives: { from: number; to: number }[] = [];
    let text = "";
    for (const marker of markers) {
      directives.push({ from: text.length, to: text.length + marker.length });
      text += `${marker} `;
    }
    return {
      directives: directives.map(({ from, to }) => ({
        from,
        to,
        kind: "placeholder" as const,
        expr: "",
        block: false,
      })),
      markerText: ({ from, to }: { from: number; to: number }) =>
        text.slice(from, to),
    };
  };

  test("puts a field's configuration into its own marker", () => {
    const doc = documentWith(["{{ rent }}", "{{ other }}"]);
    const rewrites = markerConfigRewrites({
      ...doc,
      fields: [
        studioField({ path: "rent", inputType: "number", label: "Rent" }),
      ],
    });

    expect(rewrites).toEqual([
      { from: 0, to: 10, text: '{{ rent | number | label("Rent") }}' },
    ]);
  });

  test("leaves a marker whose text already reads that way", () => {
    const doc = documentWith(['{{ rent | number | label("Rent") }}']);
    expect(
      markerConfigRewrites({
        ...doc,
        fields: [
          studioField({ path: "rent", inputType: "number", label: "Rent" }),
        ],
      }),
    ).toEqual([]);
  });

  test("writes only the repeat's own filters on a loop opener, keeping its prefix", () => {
    const doc = documentWith(["{%tr for person in people %}"]);
    const [rewrite] = markerConfigRewrites({
      ...doc,
      fields: [
        studioField({
          path: "people",
          label: "People",
          validation: { minItems: 2 },
        }),
      ],
    });

    expect(rewrite?.text).toBe(
      '{%tr for person in people | label("People") | min_items(2) %}',
    );
    expect(scanMarkers(rewrite?.text ?? "").at(0)?.prefix).toBe("row");
  });
});
