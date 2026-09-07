import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { DATE_FORMAT_SPEC_HINT } from "@stll/agent-input";
import { assertNever, classifyMarker } from "@stll/template-conditions";
import type { FilterCall } from "@stll/template-conditions";

import { discoverTemplate } from "./discover-template";
import { fieldMetaFromFilters, FIELD_META_FILTERS } from "./field-filters";
import type { FieldMeta } from "./types";

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

const makeDocx = async (paragraphs: readonly string[]): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", WRAP(paragraphs.map(P).join("")));
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

const filtersOf = (marker: string): readonly FilterCall[] => {
  const meta = classifyMarker(marker);
  if (meta?.kind !== "placeholder") {
    throw new Error(`not a value marker: ${marker}`);
  }
  return meta.filters;
};

const fieldFrom = (path: string, marker: string) =>
  fieldMetaFromFilters(path, filtersOf(marker));

describe("fieldMetaFromFilters", () => {
  test("an empty chain configures nothing", () => {
    expect(fieldFrom("deposit", "deposit")).toEqual({
      field: null,
      issues: [],
    });
  });

  test("a chain becomes the manifest field the marker declares", () => {
    expect(
      fieldFrom(
        "deposit",
        'deposit | number | label("Kaution") | hint("Two months rent") | required | min(0) | max(100000)',
      ),
    ).toEqual({
      field: {
        path: "deposit",
        inputType: "number",
        label: "Kaution",
        hint: "Two months rent",
        required: true,
        validation: { required: true, min: 0, max: 100_000 },
      },
      issues: [],
    });
  });

  test("select carries its options; options_from names its source", () => {
    expect(
      fieldFrom("kind", 'kind | select("company", "person")').field,
    ).toEqual({
      path: "kind",
      inputType: "select",
      options: ["company", "person"],
    });
    expect(fieldFrom("city", 'city | options_from("country")').field).toEqual({
      path: "city",
      optionsFrom: "country",
    });
  });

  test("checkbox is the boolean input", () => {
    expect(fieldFrom("signed", "signed | checkbox").field).toEqual({
      path: "signed",
      inputType: "boolean",
    });
  });

  test.each([
    ['date("pl-long")', { locale: "pl", style: "long" }],
    ['date("cs")', { locale: "cs", style: "long" }],
    ['date("en-GB")', { locale: "en-GB", style: "long" }],
    ['date("en-GB-short")', { locale: "en-GB", style: "short" }],
    ['date("pt-BR-short")', { locale: "pt-BR", style: "short" }],
    // Underscore is the ICU spelling of the same tag, and `full` names the
    // longest style; both are read into the canonical pair.
    ['date("cs_CZ")', { locale: "cs-CZ", style: "long" }],
    ['date("cs_CZ-long")', { locale: "cs-CZ", style: "long" }],
    ['date("pl-full")', { locale: "pl", style: "long" }],
    // An ISO date reads the same in every language, so the style stands alone.
    ['date("iso")', { locale: "en", style: "iso" }],
  ] as const satisfies readonly (readonly [
    string,
    NonNullable<FieldMeta["dateFormat"]>,
  ])[])("%s reads as a locale and a style", (filter, dateFormat) => {
    expect(fieldFrom("signed_on", `signed_on | ${filter}`).field).toEqual({
      path: "signed_on",
      inputType: "date",
      dateFormat,
    });
  });

  // A bare style names no locale, and a tag `Intl` refuses cannot be stored:
  // both ask, with the one hint the date-format reader owns.
  test.each(['date("long")', 'date("!!")'])(
    "%s is rejected by name",
    (filter) => {
      const { field, issues } = fieldFrom("signed_on", `signed_on | ${filter}`);
      expect(field).toEqual({ path: "signed_on", inputType: "date" });
      expect(issues.at(0)?.filter).toBe("date");
      expect(issues.at(0)?.hint).toBe(DATE_FORMAT_SPEC_HINT);
    },
  );

  // The wire schema refuses a maximum below 1, so a DOCX cannot be the one
  // way to save a field nobody can fill.
  test.each([
    ["max_items(0)", "max_items"],
    ["max_length(0)", "max_length"],
    ["max_items(-1)", "max_items"],
  ] as const)("%s is refused", (filter, name) => {
    const { field, issues } = fieldFrom("rows", `rows | ${filter}`);
    expect(field).toBeNull();
    expect(issues).toEqual([
      {
        filter: name,
        message: `${filter} admits nothing.`,
        hint: "A maximum is at least 1; drop the filter to leave the count open.",
      },
    ]);
  });

  // The minimums and `max` keep taking 0: a bound of 0 is a real one.
  test.each(["min_items(0)", "min_length(0)", "max(0)"])(
    "%s is a real bound",
    (filter) => {
      expect(fieldFrom("rows", `rows | ${filter}`).issues).toEqual([]);
    },
  );

  test("lookup takes the registry positionally and the formats as names", () => {
    expect(
      fieldFrom(
        "company",
        'company | lookup("krs", full="[name], [street]", address="[city]")',
      ).field,
    ).toEqual({
      path: "company",
      lookup: {
        registry: "krs",
        formats: [
          { key: "full", template: "[name], [street]" },
          { key: "address", template: "[city]" },
        ],
      },
    });
  });

  test("a lookup with no named rendering says what is missing", () => {
    const { field, issues } = fieldFrom("company", 'company | lookup("krs")');
    expect(field).toBeNull();
    expect(issues.at(0)?.hint).toContain("full=");
  });

  test("an unknown registry names the ones that exist", () => {
    const { issues } = fieldFrom(
      "company",
      'company | lookup("nope", a="[x]")',
    );
    expect(issues.at(0)?.message).toContain("no business registry");
    expect(issues.at(0)?.hint).toContain('"krs"');
  });

  test("the binding filters cover every source kind", () => {
    expect(
      fieldFrom("client", 'client | contact("email")').field?.source,
    ).toEqual({ kind: "contact", field: "email" });
    expect(fieldFrom("ref", 'ref | matter("reference")').field?.source).toEqual(
      {
        kind: "matter",
        field: "reference",
      },
    );
    expect(
      fieldFrom("firm_name", 'firm_name | firm("name")').field?.source,
    ).toEqual({ kind: "firm", field: "name" });
  });

  test("a binding to a field that does not exist lists the ones that do", () => {
    const { issues } = fieldFrom("x", 'x | matter("nickname")');
    expect(issues.at(0)?.hint).toContain('"reference"');
  });

  test("formula and condition carry their expression", () => {
    expect(
      fieldFrom("annual", 'annual | formula("base_rent * 12")').field,
    ).toEqual({ path: "annual", formula: "base_rent * 12" });
    expect(
      fieldFrom("is_company", "is_company | condition(\"kind == 'company'\")")
        .field,
    ).toEqual({ path: "is_company", condition: "kind == 'company'" });
  });

  test("ai carries the instruction and its two switches", () => {
    expect(
      fieldFrom(
        "summary",
        'summary | ai("Summarize the dispute", sees_document=true)',
      ).field,
    ).toEqual({
      path: "summary",
      aiPrompt: "Summarize the dispute",
      aiSeesDocument: true,
    });
  });

  test("two filters that both decide who fills the field are refused", () => {
    const { field, issues } = fieldFrom(
      "total",
      'total | formula("a * 2") | lookup("krs", full="[name]")',
    );
    expect(field).toBeNull();
    expect(issues.at(-1)?.message).toContain("do not describe one field");
  });
});

describe("filters on a loop path", () => {
  test("configure the array itself", async () => {
    const discovered = await discoverTemplate(
      await makeDocx([
        '{% for a in attorneys | label("Attorneys") | min_items(3) | max_items(3) | required %}',
        "{{ a.name }}",
        "{% endfor %}",
      ]),
    );

    expect(discovered.structureErrors).toEqual([]);
    expect(discovered.documentFields).toEqual([
      {
        path: "attorneys",
        label: "Attorneys",
        required: true,
        validation: { required: true, minItems: 3, maxItems: 3 },
      },
    ]);
  });

  test("a value filter on the loop path names the set that applies", async () => {
    const discovered = await discoverTemplate(
      await makeDocx([
        '{% for a in attorneys | number | label("Attorneys") %}',
        "{{ a.name }}",
        "{% endfor %}",
      ]),
    );

    const [error] = discovered.structureErrors;
    expect(error?.message).toContain("number() configures a value");
    expect(error?.message).toContain("min_items");
    // The rest of the chain still lands.
    expect(discovered.documentFields).toEqual([
      { path: "attorneys", label: "Attorneys" },
    ]);
  });
});

describe("item counts", () => {
  test("a count on an item marker declares the repeat it counts", async () => {
    const discovered = await discoverTemplate(
      await makeDocx([
        "{% for a in attorneys %}",
        '{{ a.name | label("Attorney name") | min_items(3) | max_items(3) }}',
        "{% endfor %}",
      ]),
    );

    expect(discovered.structureErrors).toEqual([]);
    expect(discovered.documentFields).toEqual([
      { path: "attorneys.name", label: "Attorney name" },
      { path: "attorneys", validation: { minItems: 3, maxItems: 3 } },
    ]);
  });

  test("the count the loop tag carries wins", async () => {
    const discovered = await discoverTemplate(
      await makeDocx([
        "{% for a in attorneys | min_items(2) %}",
        "{{ a.name | min_items(3) | min_length(2) }}",
        "{% endfor %}",
      ]),
    );

    expect(discovered.documentFields).toEqual([
      { path: "attorneys", validation: { minItems: 2 } },
      { path: "attorneys.name", validation: { minLength: 2 } },
    ]);
  });
});

describe("the filter catalogue", () => {
  test("composites are the one deliberate exclusion", () => {
    expect(FIELD_META_FILTERS.parts).toEqual({
      excluded:
        "a composite is written as document text around its part markers, so the format needs no filter",
    });
  });
});

// ── Fixed point ──────────────────────────────────────────

const quote = (value: string): string => `"${value.replaceAll('"', '\\"')}"`;

/**
 * Render one manifest field back to the filter chain that declares it. Total
 * over the manifest keys, so a property that gains a filter without gaining a
 * rendering here is a compile error rather than a field that silently stops
 * round-tripping.
 */
const FIELD_TO_FILTERS = {
  path: () => [],
  inputType: (field: FieldMeta) => {
    switch (field.inputType) {
      case undefined:
        return [];
      case "boolean":
        return ["checkbox"];
      case "date":
        return field.dateFormat
          ? [
              `date(${quote(`${field.dateFormat.locale}-${field.dateFormat.style}`)})`,
            ]
          : ["date"];
      case "select":
        return [`select(${(field.options ?? []).map(quote).join(", ")})`];
      case "number":
      case "text":
        return [field.inputType];
      default:
        return assertNever(field.inputType);
    }
  },
  // Rendered with the input type it belongs to.
  dateFormat: () => [],
  options: () => [],
  optionsFrom: (field: FieldMeta) =>
    field.optionsFrom === undefined
      ? []
      : [`options_from(${quote(field.optionsFrom)})`],
  label: (field: FieldMeta) =>
    field.label === undefined ? [] : [`label(${quote(field.label)})`],
  hint: (field: FieldMeta) =>
    field.hint === undefined ? [] : [`hint(${quote(field.hint)})`],
  required: (field: FieldMeta) => (field.required === true ? ["required"] : []),
  validation: (field: FieldMeta) => {
    const validation = field.validation;
    if (validation === undefined) {
      return [];
    }
    const parts: string[] = [];
    if (validation.pattern !== undefined) {
      parts.push(`pattern(${quote(validation.pattern)})`);
    }
    for (const [key, filter] of [
      ["min", "min"],
      ["max", "max"],
      ["minLength", "min_length"],
      ["maxLength", "max_length"],
      ["minItems", "min_items"],
      ["maxItems", "max_items"],
    ] as const) {
      const value = validation[key];
      if (value !== undefined) {
        parts.push(`${filter}(${value})`);
      }
    }
    return parts;
  },
  aiPrompt: (field: FieldMeta) => {
    if (field.aiPrompt === undefined && field.aiAdapt !== true) {
      return [];
    }
    const args: string[] = [];
    if (field.aiPrompt !== undefined) {
      args.push(quote(field.aiPrompt));
    }
    if (field.aiAdapt !== undefined) {
      args.push(`adapt=${field.aiAdapt}`);
    }
    if (field.aiSeesDocument !== undefined) {
      args.push(`sees_document=${field.aiSeesDocument}`);
    }
    return [`ai(${args.join(", ")})`];
  },
  aiAdapt: () => [],
  aiSeesDocument: () => [],
  lookup: (field: FieldMeta) =>
    field.lookup === undefined
      ? []
      : [
          `lookup(${[
            quote(field.lookup.registry),
            ...field.lookup.formats.map(
              ({ key, template }) => `${key}=${quote(template)}`,
            ),
          ].join(", ")})`,
        ],
  source: (field: FieldMeta) => {
    const source = field.source;
    if (source === undefined) {
      return [];
    }
    switch (source.kind) {
      case "party":
        return [`party(${quote(source.role)}, ${quote(source.field)})`];
      case "attorney":
        return [`attorney(${quote(source.ref)}, ${quote(source.field)})`];
      case "contact":
      case "firm":
      case "matter":
        return [`${source.kind}(${quote(source.field)})`];
      default:
        return assertNever(source);
    }
  },
  formula: (field: FieldMeta) =>
    field.formula === undefined ? [] : [`formula(${quote(field.formula)})`],
  condition: (field: FieldMeta) =>
    field.condition === undefined
      ? []
      : [`condition(${quote(field.condition)})`],
  conditionAst: () => [],
  parts: () => [],
  format: () => [],
} as const satisfies Record<keyof FieldMeta, (field: FieldMeta) => string[]>;

const markerFor = (field: FieldMeta): string => {
  const filters = Object.values(FIELD_TO_FILTERS).flatMap((render) =>
    render(field),
  );
  return filters.length === 0
    ? `{{ ${field.path} }}`
    : `{{ ${field.path} | ${filters.join(" | ")} }}`;
};

describe("the document layer is a fixed point", () => {
  test("a manifest re-authored from its own fields discovers identically", async () => {
    const authored = [
      '{{ deposit | number | label("Kaution") | required | min(0) }}',
      '{{ signed_on | date("cs-long") }}',
      '{{ kind | select("company", "person") | hint("Pick one") }}',
      '{{ company | lookup("krs", full="[name], [street]") }}',
      '{{ client_email | contact("email") }}',
      '{{ annual | formula("deposit * 12") }}',
      '{{ summary | ai("Summarize the dispute", sees_document=true) }}',
      '{{ note | text | max_length(200) | pattern("^[A-Z].*$") }}',
      "{{ plain }}",
    ];

    const first = await discoverTemplate(await makeDocx(authored));
    expect(first.structureErrors).toEqual([]);
    expect(first.documentFields.map(({ path }) => path)).toEqual([
      "annual",
      "client_email",
      "company",
      "deposit",
      "kind",
      "note",
      "signed_on",
      "summary",
    ]);

    // Re-author every discovered field from the manifest alone, then discover
    // the rewritten document: the manifest must come back unchanged.
    const reauthored = first.documentFields.map(markerFor);
    const second = await discoverTemplate(await makeDocx(reauthored));

    expect(second.structureErrors).toEqual([]);
    expect(second.documentFields).toEqual(first.documentFields);

    // And once more, so the fixed point is proven rather than a coincidence of
    // the first rewrite.
    const third = await discoverTemplate(
      await makeDocx(second.documentFields.map(markerFor)),
    );
    expect(third.documentFields).toEqual(second.documentFields);
  });

  test("two occurrences that configure the same path differently name both paragraphs", async () => {
    const discovered = await discoverTemplate(
      await makeDocx([
        '{{ deposit | number | label("Kaution") }}',
        "Some prose",
        '{{ deposit | text | label("Deposit") }}',
      ]),
    );

    expect(discovered.structureErrors).toHaveLength(1);
    const [error] = discovered.structureErrors;
    expect(error?.message).toContain("paragraph 1");
    expect(error?.message).toContain("paragraph 3");
    expect(error?.message).toContain("configured twice");
  });

  test("the identical chain repeated is not a conflict", async () => {
    const discovered = await discoverTemplate(
      await makeDocx([
        '{{ deposit | number | label("Kaution") }}',
        '{{ deposit | number | label("Kaution") }}',
      ]),
    );

    expect(discovered.structureErrors).toEqual([]);
    expect(discovered.documentFields).toHaveLength(1);
  });
});
