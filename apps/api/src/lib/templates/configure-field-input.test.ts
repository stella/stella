import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { discoverTemplate } from "@/api/lib/docx/discover-template";
import { lookupFormatMarkerPaths } from "@/api/lib/docx/template-manifest";
import type { FieldMeta } from "@/api/lib/docx/types";
import { CLEARED_FIELD_SOURCE } from "@/api/lib/docx/types";

import {
  mergeFieldConfiguration,
  partitionFieldConfiguration,
  validateFieldConfiguration,
  type ConfigurationEntry,
} from "./configure-field-input";
import { configureTemplateDocument } from "./configure-template-document";

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

const makeDocx = async (...paragraphs: string[]): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body>${paragraphs.map(P).join("")}</w:body></w:document>`,
  );
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `</Types>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

const krsLookup = (...keys: string[]): FieldMeta["lookup"] => ({
  registry: "krs",
  formats: keys.map((key) => ({ key, template: "[company name]" })),
});

/**
 * The fields the document ends up declaring: the applied entries merged onto
 * what it already said, through the production merge rule, with the markers a
 * lookup renders folded away the way the manifest merge folds them.
 */
const configurationByPath = (
  declared: readonly FieldMeta[],
  applied: readonly ConfigurationEntry[],
): FieldMeta[] => {
  const byPath = new Map(declared.map((field) => [field.path, field]));
  for (const { field } of applied) {
    byPath.set(
      field.path,
      mergeFieldConfiguration(byPath.get(field.path), field),
    );
  }
  const merged = [...byPath.values()];
  const renderings = lookupFormatMarkerPaths(merged);
  return merged.filter(({ path }) => !renderings.has(path));
};

const fields = ({ applied }: { applied: readonly ConfigurationEntry[] }) =>
  applied.map(({ field }) => field);

describe("validating entries against the document", () => {
  test("accepts a lookup on the parent of dotted markers", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    // The parent has no marker of its own: the format keys ARE the markers.
    expect(discovered.placeholders.map((p) => p.name)).not.toContain("company");

    expect(
      validateFieldConfiguration({
        configured: [],
        discovered,
        entries: [{ path: "company", lookup: krsLookup("name", "krs") }],
      }),
    ).toEqual([]);
  });

  test("accepts a lookup on a parent that also has its own marker", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company}}", "{{company.krs}}"),
    );

    expect(
      validateFieldConfiguration({
        configured: [],
        discovered,
        entries: [{ path: "company", lookup: krsLookup("default", "krs") }],
      }),
    ).toEqual([]);
  });

  test("rejects a namespace parent configured as an ordinary field", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    const issues = validateFieldConfiguration({
      configured: [],
      discovered,
      entries: [
        { path: "company.name", label: "Name" },
        { path: "company", label: "Company" },
      ],
    });

    // The leaf marker stays configurable; only the structural parent is refused.
    expect(issues.map(({ path }) => path)).toEqual(["fields.1"]);
    expect(issues.at(0)?.message).toContain("{{company.name}}");
    expect(issues.at(0)?.message).toContain("{{company.krs}}");
  });

  test("accepts a repeat's root and the item paths inside it", async () => {
    const discovered = await discoverTemplate(
      await makeDocx(
        "{% for attorney in attorneys %}",
        "{{ attorney.name }} of {{ attorney.firm }}",
        "{% endfor %}",
      ),
    );

    // The array root is a value-bearing input (min_items, max_items), and each
    // item path is a field the fill form asks once per row.
    expect(
      validateFieldConfiguration({
        configured: [],
        discovered,
        entries: [
          { path: "attorneys", validation: { minItems: 1 } },
          { path: "attorneys.name", label: "Attorney name", required: true },
          { path: "attorneys.firm", inputType: "text" },
        ],
      }),
    ).toEqual([]);
  });

  test("rejects a path with no marker at all", async () => {
    const discovered = await discoverTemplate(await makeDocx("{{company}}"));

    const issues = validateFieldConfiguration({
      configured: [],
      discovered,
      entries: [{ path: "company" }, { path: "ghost", label: "Ghost" }],
    });

    expect(issues).toEqual([
      {
        path: "fields.1",
        index: 1,
        message: "No marker {{ghost}} in the DOCX.",
        hint:
          "Configure only the paths the template reported. To add a field, " +
          "put its {{marker}} in the document and publish a new version.",
      },
    ]);
  });

  test("a field configured at a lookup format key is that format, not a rival", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    // The marker belongs to the lookup that renders it, so neither entry is
    // refused: the child folds and what a format cannot hold is reported.
    expect(
      validateFieldConfiguration({
        configured: [],
        discovered,
        entries: [
          { path: "company", lookup: krsLookup("name", "krs") },
          { path: "company.name", inputType: "number", label: "Company name" },
        ],
      }),
    ).toEqual([]);
  });

  test("an already-configured child is a rendering the incoming lookup claims", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    expect(
      validateFieldConfiguration({
        configured: [{ path: "company.name", inputType: "number" }],
        discovered,
        entries: [{ path: "company", lookup: krsLookup("name", "krs") }],
      }),
    ).toEqual([]);
  });

  test("a bare declared child entry is a marker, not a rival configuration", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    // A marker with no filters declares `{ path }` and nothing else. That is
    // not an authored decision, so a later lookup may claim it.
    expect(
      validateFieldConfiguration({
        configured: [{ path: "company.name" }, { path: "company.krs" }],
        discovered,
        entries: [{ path: "company", lookup: krsLookup("name", "krs") }],
      }),
    ).toEqual([]);
  });

  test("lookup ownership resolves the same across every split of declared and incoming configuration", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}"),
    );
    const owner = { path: "company", lookup: krsLookup("name") };
    const child = {
      path: "company.name",
      label: "Legal name",
      inputType: "number" as const,
    };
    for (const { configured, entries } of [
      { configured: [owner], entries: [child] },
      { configured: [child], entries: [owner] },
      { configured: [], entries: [owner, child] },
      { configured: [], entries: [child, owner] },
    ]) {
      const { applied, issues } = partitionFieldConfiguration({
        configured,
        discovered,
        entries,
      });
      // Whichever side the child came from, one lookup carries the marker and
      // no entry is refused: every issue names a property of an entry that
      // landed.
      expect(configurationByPath(configured, applied)).toEqual([owner]);
      expect(issues.every(({ property }) => property !== undefined)).toBe(true);
    }
  });

  test("an existing lookup can be relabelled or release a previously owned format", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.full}}"),
    );
    const configured = [{ path: "company", lookup: krsLookup("name") }];
    for (const entries of [
      [{ path: "company", label: "Legal entity" }],
      [
        { path: "company", lookup: krsLookup("full") },
        { path: "company.name", label: "Separate name" },
      ],
    ]) {
      expect(
        validateFieldConfiguration({ configured, discovered, entries }),
      ).toEqual([]);
    }
  });

  test("duplicate paths are rejected whether the field already exists or is newly declared", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}"),
    );
    const field = { path: "company", lookup: krsLookup("name") };
    for (const configured of [[], [field]]) {
      const issues = validateFieldConfiguration({
        configured,
        discovered,
        entries: [field, field],
      });
      expect(issues).toEqual([
        expect.objectContaining({
          path: "fields.1",
          message: expect.stringContaining("more than once"),
        }),
      ]);
    }
  });
});

describe("loop aliases at the configure boundary", () => {
  const loopDocx = async () =>
    makeDocx(
      "appoints: {% for attorney in attorneys %}{{ attorney.name }}" +
        "{% if not loop.last %}, {% endif %}{% endfor %}.",
    );

  test("discovery reports the name the loop bound and the array it stands for", async () => {
    const discovered = await discoverTemplate(await loopDocx());

    expect(discovered.loopAliases).toEqual([
      { alias: "attorney", path: "attorneys" },
    ]);
  });

  test("an entry written through the loop alias configures the array's item field", async () => {
    const discovered = await discoverTemplate(await loopDocx());

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [{ path: "attorney.name", label: "Attorney name" }],
    });

    expect(partitioned.issues).toEqual([]);
    expect(fields(partitioned)).toEqual([
      { path: "attorneys.name", label: "Attorney name" },
    ]);
  });

  test("the bare array root carries the loop's own properties", async () => {
    const discovered = await discoverTemplate(await loopDocx());

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [
        {
          path: "attorneys",
          label: "Attorneys",
          required: true,
          validation: { minItems: 3, maxItems: 3 },
        },
      ],
    });

    expect(partitioned.issues).toEqual([]);
    expect(fields(partitioned).at(0)?.path).toBe("attorneys");
  });

  test("an item count written on the item path lands on the array", async () => {
    const discovered = await discoverTemplate(await loopDocx());

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [
        {
          path: "attorney.name",
          label: "Attorney name",
          required: true,
          validation: { minItems: 3, maxItems: 3 },
        },
      ],
    });

    expect(partitioned.issues).toEqual([]);
    expect(fields(partitioned)).toEqual([
      { path: "attorneys.name", label: "Attorney name", required: true },
      { path: "attorneys", validation: { minItems: 3, maxItems: 3 } },
    ]);
  });

  test("a count the array declares itself wins over one on an item", async () => {
    const discovered = await discoverTemplate(await loopDocx());

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [
        { path: "attorneys", validation: { minItems: 2 } },
        { path: "attorney.name", validation: { minItems: 3, minLength: 2 } },
      ],
    });

    expect(fields(partitioned)).toEqual([
      { path: "attorneys", validation: { minItems: 2 } },
      { path: "attorneys.name", validation: { minLength: 2 } },
    ]);
  });

  test("a name no loop bound is still refused, naming the declared paths", async () => {
    const discovered = await discoverTemplate(await loopDocx());

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [{ path: "lawyer.name", label: "Lawyer" }],
    });

    expect(partitioned.applied).toEqual([]);
    expect(partitioned.issues.at(0)?.message).toContain(
      "No marker {{lawyer.name}}",
    );
  });

  test("a real path always wins over the alias reading", async () => {
    const discovered = await discoverTemplate(
      await makeDocx(
        "{{ attorney.name }}",
        "{% for attorney in attorneys %}",
        "{{ attorney.name }}",
        "{% endfor %}",
      ),
    );

    // The loop body's own marker is the array's item field; the paragraph
    // above the loop declares a top-level `attorney.name`. Configuring that
    // path means the field that exists under that exact name.
    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [{ path: "attorney.name", label: "Attorney" }],
    });

    expect(fields(partitioned).at(0)?.path).toBe("attorney.name");
  });
});

describe("a group of markers at the configure boundary", () => {
  const addressDocx = async () =>
    makeDocx(
      "{{ property_address.street }}",
      "{{ property_address.postal_code }} {{ property_address.city }}",
    );

  test("the entry is never refused: its properties are dropped one by one", async () => {
    const discovered = await discoverTemplate(await addressDocx());

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [
        {
          path: "property_address",
          label: "Anschrift des Mietobjekts",
          hint: "Straße, PLZ, Ort",
          inputType: "text",
          required: false,
          source: { kind: "contact", field: "address" },
        },
        { path: "property_address.city", label: "Ort" },
      ],
    });

    expect(partitioned.issues.map(({ path }) => path)).toEqual([
      "fields.0.label",
      "fields.0.hint",
      "fields.0.input_type",
      "fields.0.source",
    ]);
    expect(partitioned.issues.at(0)?.message).toBe(
      '"property_address" is a group of {{property_address.city}}, ' +
        "{{property_address.postal_code}}, {{property_address.street}}; a " +
        "group carries no label.",
    );
    // The entry beside it, and the group's own path, are unaffected.
    expect(fields(partitioned)).toEqual([
      { path: "property_address.city", label: "Ort" },
    ]);
  });

  test("required propagates to every child that does not answer it", async () => {
    const discovered = await discoverTemplate(await addressDocx());

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [
        { path: "property_address", required: true },
        { path: "property_address.city", label: "Ort", required: false },
      ],
    });

    expect(fields(partitioned)).toEqual([
      { path: "property_address.city", label: "Ort", required: false },
      { path: "property_address.postal_code", required: true },
      { path: "property_address.street", required: true },
    ]);
  });

  test("a path that is neither a marker nor a group is still refused", async () => {
    const discovered = await discoverTemplate(await addressDocx());

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [{ path: "landlord_address", label: "Anschrift" }],
    });

    expect(partitioned.applied).toEqual([]);
    expect(partitioned.issues.map(({ path }) => path)).toEqual(["fields.0"]);
    expect(partitioned.issues.at(0)?.message).toContain(
      "No marker {{landlord_address}}",
    );
  });

  test("a lookup makes the same path the one input, not a group", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [
        { path: "company", label: "Company", lookup: krsLookup("name", "krs") },
      ],
    });

    expect(partitioned.issues).toEqual([]);
    expect(fields(partitioned).at(0)?.label).toBe("Company");
  });
});

describe("a condition that answers itself", () => {
  test("a condition that reads only its own field is read as absent", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{ expenses_reimbursed }}", "{{ expense_cap }}"),
    );

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [
        {
          path: "expenses_reimbursed",
          label: "Expenses reimbursed",
          inputType: "boolean",
          condition: "expenses_reimbursed == true",
        },
        { path: "expense_cap", condition: "expenses_reimbursed" },
      ],
    });

    expect(partitioned.issues).toEqual([]);
    expect(fields(partitioned)).toEqual([
      {
        path: "expenses_reimbursed",
        label: "Expenses reimbursed",
        inputType: "boolean",
      },
      // A condition on ANOTHER field's value still decides something.
      { path: "expense_cap", condition: "expenses_reimbursed" },
    ]);
  });

  test("a condition that reads its own path among others stands", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{ expenses_reimbursed }}", "{{ expense_cap }}"),
    );

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [
        {
          path: "expenses_reimbursed",
          condition: "expenses_reimbursed and expense_cap > 0",
        },
      ],
    });

    expect(fields(partitioned).at(0)?.condition).toBe(
      "expenses_reimbursed and expense_cap > 0",
    );
  });
});

describe("a child restating the parent's lookup", () => {
  const companyDocx = async () =>
    makeDocx("{{company}}", "{{company.address}}", "{{company.krs}}");

  /** How a model describes every marker it can see: the registry lookup on the
   *  parent, and each dotted marker as the same lookup rendered its own way. */
  const perMarkerEntries = (registry: FieldMeta["lookup"]): FieldMeta[] => [
    {
      path: "company",
      label: "Company",
      lookup: krsLookup("name", "address", "krs"),
    },
    {
      path: "company.address",
      label: "Registered address",
      lookup: {
        registry: "krs",
        formats: [
          { key: "default", template: "[street], [postal_code] [city]" },
        ],
      },
    },
    { path: "company.krs", label: "KRS number", lookup: registry },
  ];

  const krsChild = {
    registry: "krs" as const,
    formats: [{ key: "default", template: "[registration_number]" }],
  };

  test("folds into the parent's format for that key", async () => {
    const discovered = await discoverTemplate(await companyDocx());
    const configured = [{ path: "company.address" }, { path: "company.krs" }];

    const partitioned = partitionFieldConfiguration({
      configured,
      discovered,
      entries: perMarkerEntries(krsChild),
    });

    expect(partitioned.issues).toEqual([]);
    // The children are the parent's renderings, so one field carries all three
    // and their templates are the ones the child entries declared.
    expect(configurationByPath(configured, partitioned.applied)).toEqual([
      {
        path: "company",
        label: "Company",
        lookup: {
          registry: "krs",
          formats: [
            { key: "name", template: "[company name]" },
            { key: "address", template: "[street], [postal_code] [city]" },
            { key: "krs", template: "[registration_number]" },
          ],
        },
      },
    ]);
  });

  /**
   * The other shape a model sends for the same document: every dotted marker
   * described as a fillable field of its own — wording, an input type, a
   * required flag, value constraints — with the format's lookup beside it.
   * The template is the one part a format can take.
   */
  test("a child that describes a whole field reports what the format cannot hold", async () => {
    const discovered = await discoverTemplate(await companyDocx());

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [
        {
          path: "company",
          label: "Company",
          lookup: krsLookup("address", "krs"),
        },
        {
          path: "company.address",
          label: "Registered address",
          hint: "From the register",
          inputType: "text",
          required: true,
          validation: { minLength: 5, maxLength: 200, pattern: "^.+$" },
          lookup: {
            registry: "krs",
            formats: [{ key: "address", template: "[street], [city]" }],
          },
        },
      ],
    });

    expect(
      partitioned.issues.map(({ path, property }) => [path, property]),
    ).toEqual([
      ["fields.1.validation", "validation"],
      ["fields.1.required", "required"],
    ]);
    expect(configurationByPath([], partitioned.applied)).toEqual([
      {
        path: "company",
        label: "Company",
        lookup: {
          registry: "krs",
          formats: [
            { key: "address", template: "[street], [city]" },
            { key: "krs", template: "[company name]" },
          ],
        },
      },
    ]);
  });

  test("a child restating every format of the parent's lookup keeps the parent's", async () => {
    const discovered = await discoverTemplate(await companyDocx());
    const wholeLookup = krsLookup("address", "krs");

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [
        { path: "company", lookup: wholeLookup },
        { path: "company.address", lookup: wholeLookup },
      ],
    });

    // A format is one rendering, so a child offering both cannot say which of
    // them "address" is: the parent's formats stand.
    expect(partitioned.issues.map(({ path }) => path)).toEqual([
      "fields.1.source",
    ]);
    expect(partitioned.issues.at(0)?.message).toBe(
      '"company.address" renders the "address" format of "company"\'s ' +
        "lookup; a format is one rendering, so the lookup sent on " +
        '"company.address", which names 2, was dropped.',
    );
    expect(configurationByPath([], partitioned.applied)).toEqual([
      { path: "company", lookup: wholeLookup },
    ]);
  });

  test("a child that binds elsewhere and formats a date folds without them", async () => {
    const discovered = await discoverTemplate(await companyDocx());

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [
        { path: "company", lookup: krsLookup("address", "krs") },
        {
          path: "company.address",
          label: "Registered address",
          source: { kind: "contact", field: "address" },
          dateFormat: { locale: "pl-PL", style: "long" },
        },
      ],
    });

    expect(partitioned.issues.map(({ path }) => path)).toEqual([
      "fields.1.source",
      "fields.1.date_format",
    ]);
    expect(partitioned.issues.at(1)?.message).toBe(
      '"company.address" renders the "address" format of "company"\'s ' +
        "lookup; a format carries no date_format, so it was dropped.",
    );
    expect(configurationByPath([], partitioned.applied)).toEqual([
      { path: "company", lookup: krsLookup("address", "krs") },
    ]);
  });

  test("a child on a different registry keeps the parent's registry", async () => {
    const discovered = await discoverTemplate(await companyDocx());

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: perMarkerEntries({
        registry: "ares",
        formats: [{ key: "default", template: "[registration_number]" }],
      }),
    });

    // One registry fills the parent, so the second one is dropped off the
    // entry that sent it; the entry itself lands.
    expect(partitioned.issues.map(({ path }) => path)).toEqual([
      "fields.2.source",
    ]);
    expect(partitioned.issues.at(0)?.message).toBe(
      '"company.krs" renders the "krs" format of "company"\'s lookup, which ' +
        "queries krs; a format carries no registry of its own, so the ares " +
        'lookup sent on "company.krs" was dropped.',
    );
    expect(configurationByPath([], partitioned.applied)).toEqual([
      {
        path: "company",
        label: "Company",
        lookup: {
          registry: "krs",
          formats: [
            { key: "name", template: "[company name]" },
            { key: "address", template: "[street], [postal_code] [city]" },
            { key: "krs", template: "[company name]" },
          ],
        },
      },
    ]);
  });

  test("a child carrying what a format cannot hold folds without it", async () => {
    const discovered = await discoverTemplate(await companyDocx());

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [
        { path: "company", lookup: krsLookup("name", "krs") },
        { path: "company.krs", inputType: "number", lookup: krsChild },
      ],
    });

    expect(partitioned.issues.map(({ path }) => path)).toEqual([
      "fields.1.input_type",
    ]);
    expect(partitioned.issues.at(0)?.message).toBe(
      '"company.krs" renders the "krs" format of "company"\'s lookup; a ' +
        "format carries no input_type, so it was dropped.",
    );
    // The template the child declared is the one thing a format can take.
    expect(
      configurationByPath([], partitioned.applied).at(0)?.lookup?.formats,
    ).toEqual([
      { key: "name", template: "[company name]" },
      { key: "krs", template: "[registration_number]" },
    ]);
  });

  /** How a model that never repeats the lookup describes the same document:
   *  the parent carries every format, and each dotted marker is an entry
   *  filled in with the shape every entry has and nothing else. */
  const shapeOnlyEntries = (): FieldMeta[] => [
    {
      path: "company",
      label: "Company",
      lookup: {
        registry: "krs",
        formats: [
          { key: "address", template: "[street], [postal_code] [city]" },
          { key: "krs", template: "[registration_number]" },
        ],
      },
    },
    {
      path: "company.address",
      label: "Registered address",
      hint: "From the register",
      inputType: "text",
      required: false,
    },
    {
      path: "company.krs",
      label: "KRS number",
      inputType: "text",
      required: false,
    },
  ];

  test("a child carrying only what a format cannot hold folds too", async () => {
    const discovered = await discoverTemplate(await companyDocx());
    const entries = shapeOnlyEntries();

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries,
    });

    expect(partitioned.issues).toEqual([]);
    // One field, and the formats are the parent's: the children said nothing
    // a format could not already hold, so nothing of theirs survives.
    expect(configurationByPath([], partitioned.applied)).toEqual(
      entries.slice(0, 1),
    );
  });

  test("a child that names a real input type folds without it", async () => {
    const discovered = await discoverTemplate(await companyDocx());

    const partitioned = partitionFieldConfiguration({
      configured: [],
      discovered,
      entries: [
        ...shapeOnlyEntries().slice(0, 1),
        { path: "company.krs", inputType: "number" },
      ],
    });

    expect(partitioned.issues.map(({ path }) => path)).toEqual([
      "fields.1.input_type",
    ]);
    expect(configurationByPath([], partitioned.applied)).toEqual(
      shapeOnlyEntries().slice(0, 1),
    );
  });

  test.each([
    [
      "a model that repeats the lookup per marker",
      perMarkerEntries(krsChild),
      3,
    ],
    ["a model that describes each marker's shape", shapeOnlyEntries(), 2],
  ] as [string, FieldMeta[], number][])(
    "configuring the same entries twice changes nothing more (%s)",
    async (_name, entries, formatCount) => {
      const first = await configureTemplateDocument({
        buffer: await companyDocx(),
        entries,
      });
      const second = await configureTemplateDocument({
        buffer: first.buffer,
        entries,
      });

      expect(first.issues.map(({ path }) => path)).toEqual(
        second.issues.map(({ path }) => path),
      );
      expect(second.manifest).toEqual(first.manifest);
      // Every dotted marker is a rendering of the one lookup, so the document
      // ends up with one field carrying every format the entries described.
      expect(first.manifest.fields.map(({ path }) => path)).toEqual([
        "company",
      ]);
      expect(first.manifest.fields.at(0)?.lookup?.formats).toHaveLength(
        formatCount,
      );
    },
  );
});

describe("merging an entry onto what the marker already says", () => {
  test("a property the entry does not name keeps the marker's", () => {
    expect(
      mergeFieldConfiguration(
        { path: "signed_on", inputType: "date" },
        { path: "signed_on", label: "Signature date" },
      ),
    ).toEqual({
      path: "signed_on",
      inputType: "date",
      label: "Signature date",
    });
  });

  test("naming any source replaces the whole cluster", () => {
    // The marker can only carry one answer to who fills the field, so a field
    // that was AI-drafted and is now a registry lookup must not keep both.
    expect(
      mergeFieldConfiguration(
        { path: "recitals", label: "Recitals", aiPrompt: "Draft it" },
        {
          path: "recitals",
          ...CLEARED_FIELD_SOURCE,
          lookup: krsLookup("name"),
        },
      ),
    ).toEqual({
      path: "recitals",
      label: "Recitals",
      lookup: krsLookup("name"),
    });
  });

  test("a path the document declares nothing about is the entry itself", () => {
    expect(
      mergeFieldConfiguration(undefined, { path: "fee", label: "Fee" }),
    ).toEqual({ path: "fee", label: "Fee" });
  });
});

/**
 * The marker is the store, so a configuration that decides who fills a field
 * has to REPLACE what the marker said. Without that, the marker's own filter
 * would be read again on the next describe or fill and quietly undo a
 * configuration the tool reported as applied.
 */
describe("a source the configuration decided", () => {
  const aiDocx = async () =>
    makeDocx('{{ recitals | ai("Draft the recitals") }}');

  test.each([
    ["a person fills it", {}],
    ["a registry lookup fills it", { lookup: krsLookup("name") }],
  ] as [string, Partial<FieldMeta>][])(
    "the marker stops declaring the AI draft when %s",
    async (_name, source) => {
      const buffer = await aiDocx();
      expect((await discoverTemplate(buffer)).documentFields).toEqual([
        expect.objectContaining({
          path: "recitals",
          aiPrompt: "Draft the recitals",
        }),
      ]);

      const { issues, manifest } = await configureTemplateDocument({
        buffer,
        entries: [{ path: "recitals", ...CLEARED_FIELD_SOURCE, ...source }],
      });

      expect(issues).toEqual([]);
      const field = manifest.fields.find(({ path }) => path === "recitals");
      expect(field?.aiPrompt).toBeUndefined();
      expect(field?.lookup).toEqual(source.lookup);
    },
  );

  test("a marker's filter still configures a field the entry says nothing about", async () => {
    const { manifest } = await configureTemplateDocument({
      buffer: await aiDocx(),
      entries: [{ path: "recitals", label: "Recitals" }],
    });

    const field = manifest.fields.find(({ path }) => path === "recitals");
    expect(field?.label).toBe("Recitals");
    expect(field?.aiPrompt).toBe("Draft the recitals");
  });
});
