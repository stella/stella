import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { discoverTemplate } from "@/api/lib/docx/discover-template";
import type { FieldMeta } from "@/api/lib/docx/types";

import {
  applyFieldOverlay,
  partitionFieldOverlay,
  resolveTemplateFieldOverlay,
  validateFieldOverlay,
} from "./field-overlay";

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

describe("validateFieldOverlay", () => {
  test("accepts a lookup on the parent of dotted markers", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    // The parent has no marker of its own: the format keys ARE the markers.
    expect(discovered.placeholders.map((p) => p.name)).not.toContain("company");

    expect(
      validateFieldOverlay({
        configured: [],
        discovered,
        overlay: [{ path: "company", lookup: krsLookup("name", "krs") }],
      }),
    ).toEqual([]);
  });

  test("accepts a lookup on a parent that also has its own marker", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company}}", "{{company.krs}}"),
    );

    expect(
      validateFieldOverlay({
        configured: [],
        discovered,
        overlay: [{ path: "company", lookup: krsLookup("default", "krs") }],
      }),
    ).toEqual([]);
  });

  test("rejects a namespace parent configured as an ordinary field", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    const issues = validateFieldOverlay({
      configured: [],
      discovered,
      overlay: [
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
      validateFieldOverlay({
        configured: [],
        discovered,
        overlay: [
          { path: "attorneys", validation: { minItems: 1 } },
          { path: "attorneys.name", label: "Attorney name", required: true },
          { path: "attorneys.firm", inputType: "text" },
        ],
      }),
    ).toEqual([]);
  });

  test("rejects a path with no marker at all", async () => {
    const discovered = await discoverTemplate(await makeDocx("{{company}}"));

    const issues = validateFieldOverlay({
      configured: [],
      discovered,
      overlay: [{ path: "company" }, { path: "ghost", label: "Ghost" }],
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

  test("rejects a lookup format key that collides with a configured field", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    const issues = validateFieldOverlay({
      configured: [],
      discovered,
      overlay: [
        { path: "company", lookup: krsLookup("name", "krs") },
        { path: "company.name", inputType: "number", label: "Company name" },
      ],
    });

    // Both sides of the collision are named, each at its own entry index.
    expect(issues.map(({ path }) => path)).toEqual(["fields.0", "fields.1"]);
    for (const { message } of issues) {
      expect(message).toContain('"company"');
      expect(message).toContain('"company.name"');
    }
  });

  test("rejects a lookup colliding with an already-configured child", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    const issues = validateFieldOverlay({
      configured: [{ path: "company.name", inputType: "number" }],
      discovered,
      overlay: [{ path: "company", lookup: krsLookup("name", "krs") }],
    });

    expect(issues.map(({ path }) => path)).toEqual(["fields.0"]);
  });

  test("a bare discovered child entry is a marker, not a rival configuration", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    // Creation records every discovered marker in the manifest as `{ path }`.
    // That is not an authored decision, so a later lookup may claim it.
    expect(
      validateFieldOverlay({
        configured: [{ path: "company.name" }, { path: "company.krs" }],
        discovered,
        overlay: [{ path: "company", lookup: krsLookup("name", "krs") }],
      }),
    ).toEqual([]);
  });

  test("lookup ownership is enforced across every split of existing and incoming configuration", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}"),
    );
    const owner = { path: "company", lookup: krsLookup("name") };
    const child = {
      path: "company.name",
      label: "Legal name",
      inputType: "number" as const,
    };
    for (const { configured, overlay } of [
      { configured: [owner], overlay: [child] },
      { configured: [child], overlay: [owner] },
      { configured: [], overlay: [owner, child] },
      { configured: [], overlay: [child, owner] },
    ]) {
      const issues = validateFieldOverlay({ configured, discovered, overlay });
      expect(new Set(issues.map(({ path }) => path))).toEqual(
        new Set(overlay.map((_, index) => `fields.${index}`)),
      );
      for (const { message } of issues) {
        expect(message).toContain('"company"');
        expect(message).toContain('"company.name"');
      }
    }
  });

  test("an existing lookup can be relabelled or release a previously owned format", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.full}}"),
    );
    const configured = [{ path: "company", lookup: krsLookup("name") }];
    for (const overlay of [
      [{ path: "company", label: "Legal entity" }],
      [
        { path: "company", lookup: krsLookup("full") },
        { path: "company.name", label: "Separate name" },
      ],
    ]) {
      expect(validateFieldOverlay({ configured, discovered, overlay })).toEqual(
        [],
      );
    }
  });

  test("duplicate overlay paths are rejected whether the field already exists or is newly discovered", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}"),
    );
    const field = { path: "company", lookup: krsLookup("name") };
    for (const configured of [[], [field]]) {
      const issues = validateFieldOverlay({
        configured,
        discovered,
        overlay: [field, field],
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

    const { applied, issues } = partitionFieldOverlay({
      configured: [],
      discovered,
      overlay: [{ path: "attorney.name", label: "Attorney name" }],
    });

    expect(issues).toEqual([]);
    expect(applied).toEqual([
      { path: "attorneys.name", label: "Attorney name" },
    ]);
  });

  test("the bare array root carries the loop's own properties", async () => {
    const discovered = await discoverTemplate(await loopDocx());

    const { applied, issues } = partitionFieldOverlay({
      configured: [],
      discovered,
      overlay: [
        {
          path: "attorneys",
          label: "Attorneys",
          required: true,
          validation: { minItems: 3, maxItems: 3 },
        },
      ],
    });

    expect(issues).toEqual([]);
    expect(applied.at(0)?.path).toBe("attorneys");
  });

  test("an item count written on the item path lands on the array", async () => {
    const discovered = await discoverTemplate(await loopDocx());

    const { applied, issues } = partitionFieldOverlay({
      configured: [],
      discovered,
      overlay: [
        {
          path: "attorney.name",
          label: "Attorney name",
          required: true,
          validation: { minItems: 3, maxItems: 3 },
        },
      ],
    });

    expect(issues).toEqual([]);
    expect(applied).toEqual([
      { path: "attorneys.name", label: "Attorney name", required: true },
      { path: "attorneys", validation: { minItems: 3, maxItems: 3 } },
    ]);
  });

  test("a count the array declares itself wins over one on an item", async () => {
    const discovered = await discoverTemplate(await loopDocx());

    const { applied } = partitionFieldOverlay({
      configured: [],
      discovered,
      overlay: [
        { path: "attorneys", validation: { minItems: 2 } },
        {
          path: "attorney.name",
          validation: { minItems: 3, minLength: 2 },
        },
      ],
    });

    expect(applied).toEqual([
      { path: "attorneys", validation: { minItems: 2 } },
      { path: "attorneys.name", validation: { minLength: 2 } },
    ]);
  });

  test("a name no loop bound is still refused, naming the discovered paths", async () => {
    const discovered = await discoverTemplate(await loopDocx());

    const { applied, issues } = partitionFieldOverlay({
      configured: [],
      discovered,
      overlay: [{ path: "lawyer.name", label: "Lawyer" }],
    });

    expect(applied).toEqual([]);
    expect(issues.at(0)?.message).toContain("No marker {{lawyer.name}}");
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
    const { applied } = partitionFieldOverlay({
      configured: [],
      discovered,
      overlay: [{ path: "attorney.name", label: "Attorney" }],
    });

    expect(applied.at(0)?.path).toBe("attorney.name");
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

    const { applied, issues } = partitionFieldOverlay({
      configured: [],
      discovered,
      overlay: [
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

    expect(issues.map(({ path }) => path)).toEqual([
      "fields.0.label",
      "fields.0.hint",
      "fields.0.input_type",
      "fields.0.source",
    ]);
    expect(issues.at(0)?.message).toBe(
      '"property_address" is a group of {{property_address.city}}, ' +
        "{{property_address.postal_code}}, {{property_address.street}}; a " +
        "group carries no label.",
    );
    // The entry beside it, and the group's own path, are unaffected.
    expect(applied).toEqual([{ path: "property_address.city", label: "Ort" }]);
  });

  test("required propagates to every child that does not answer it", async () => {
    const discovered = await discoverTemplate(await addressDocx());

    const { applied } = partitionFieldOverlay({
      configured: [],
      discovered,
      overlay: [
        { path: "property_address", required: true },
        { path: "property_address.city", label: "Ort", required: false },
      ],
    });

    expect(applied).toEqual([
      { path: "property_address.city", label: "Ort", required: false },
      { path: "property_address.postal_code", required: true },
      { path: "property_address.street", required: true },
    ]);
  });

  test("a path that is neither a marker nor a group is still refused", async () => {
    const discovered = await discoverTemplate(await addressDocx());

    const { applied, issues } = partitionFieldOverlay({
      configured: [],
      discovered,
      overlay: [{ path: "landlord_address", label: "Anschrift" }],
    });

    expect(applied).toEqual([]);
    expect(issues.map(({ path }) => path)).toEqual(["fields.0"]);
    expect(issues.at(0)?.message).toContain("No marker {{landlord_address}}");
  });

  test("a lookup makes the same path the one input, not a group", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    const { applied, issues } = partitionFieldOverlay({
      configured: [],
      discovered,
      overlay: [
        { path: "company", label: "Company", lookup: krsLookup("name", "krs") },
      ],
    });

    expect(issues).toEqual([]);
    expect(applied.at(0)?.label).toBe("Company");
  });
});

describe("a condition that answers itself", () => {
  test("a condition that reads only its own field is read as absent", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{ expenses_reimbursed }}", "{{ expense_cap }}"),
    );

    const { applied, issues } = partitionFieldOverlay({
      configured: [],
      discovered,
      overlay: [
        {
          path: "expenses_reimbursed",
          label: "Expenses reimbursed",
          inputType: "boolean",
          condition: "expenses_reimbursed == true",
        },
        { path: "expense_cap", condition: "expenses_reimbursed" },
      ],
    });

    expect(issues).toEqual([]);
    expect(applied).toEqual([
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

    const { applied } = partitionFieldOverlay({
      configured: [],
      discovered,
      overlay: [
        {
          path: "expenses_reimbursed",
          condition: "expenses_reimbursed and expense_cap > 0",
        },
      ],
    });

    expect(applied.at(0)?.condition).toBe(
      "expenses_reimbursed and expense_cap > 0",
    );
  });
});

describe("a child restating the parent's lookup", () => {
  const companyDocx = async () =>
    makeDocx("{{company}}", "{{company.address}}", "{{company.krs}}");

  /** How a model describes every marker it can see: the registry lookup on the
   *  parent, and each dotted marker as the same lookup rendered its own way. */
  const perMarkerOverlay = (registry: FieldMeta["lookup"]) => [
    {
      path: "company",
      label: "Company",
      lookup: krsLookup("name", "address", "krs"),
    },
    {
      path: "company.address",
      label: "Registered address",
      lookup: {
        registry: "krs" as const,
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

    const { applied, issues } = partitionFieldOverlay({
      configured,
      discovered,
      overlay: perMarkerOverlay(krsChild),
    });

    expect(issues).toEqual([]);
    // The children are the parent's renderings, so one field carries all three
    // and their templates are the ones the child entries declared.
    expect(
      applyFieldOverlay({ version: 1, fields: configured }, applied).fields,
    ).toEqual([
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

  test("a child on a different registry is still refused", async () => {
    const discovered = await discoverTemplate(await companyDocx());

    const { applied, issues } = partitionFieldOverlay({
      configured: [],
      discovered,
      overlay: perMarkerOverlay({
        registry: "ares",
        formats: [{ key: "default", template: "[registration_number]" }],
      }),
    });

    expect(issues.map(({ path }) => path)).toEqual(["fields.0", "fields.2"]);
    for (const { message } of issues) {
      expect(message).toContain('"company.krs"');
    }
    expect(applied.map(({ path }) => path)).toEqual(["company.address"]);
  });

  test("a child carrying what a format cannot hold is still refused", async () => {
    const discovered = await discoverTemplate(await companyDocx());

    const { issues } = partitionFieldOverlay({
      configured: [],
      discovered,
      overlay: [
        { path: "company", lookup: krsLookup("name", "krs") },
        { path: "company.krs", inputType: "number", lookup: krsChild },
      ],
    });

    expect(issues.map(({ path }) => path)).toEqual(["fields.0", "fields.1"]);
  });

  /** How a model that never repeats the lookup describes the same document:
   *  the parent carries every format, and each dotted marker is an entry
   *  filled in with the shape every entry has and nothing else. */
  const shapeOnlyOverlay = (): FieldMeta[] => [
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
    const overlay = shapeOnlyOverlay();

    const { applied, issues } = partitionFieldOverlay({
      configured: [],
      discovered,
      overlay,
    });

    expect(issues).toEqual([]);
    // One field, and the formats are the parent's: the children said nothing
    // a format could not already hold, so nothing of theirs survives.
    expect(applyFieldOverlay(null, applied).fields).toEqual(
      overlay.slice(0, 1),
    );
  });

  test("a child that names a real input type is still refused", async () => {
    const discovered = await discoverTemplate(await companyDocx());

    const { issues } = partitionFieldOverlay({
      configured: [],
      discovered,
      overlay: [
        ...shapeOnlyOverlay().slice(0, 1),
        { path: "company.krs", inputType: "number" },
      ],
    });

    expect(issues.map(({ path }) => path)).toEqual(["fields.0", "fields.1"]);
  });

  test("a second configure of the shape-only overlay changes nothing", async () => {
    const discovered = await discoverTemplate(await companyDocx());
    const overlay = shapeOnlyOverlay();

    const first = resolveTemplateFieldOverlay({
      discovered,
      manifest: null,
      overlay: partitionFieldOverlay({ configured: [], discovered, overlay })
        .applied,
    });
    const second = resolveTemplateFieldOverlay({
      discovered,
      manifest: first,
      overlay: partitionFieldOverlay({
        configured: first.fields,
        discovered,
        overlay,
      }).applied,
    });

    expect(second).toEqual(first);
  });

  test("configuring the same overlay twice resolves the same manifest", async () => {
    const discovered = await discoverTemplate(await companyDocx());
    const overlay = perMarkerOverlay(krsChild);

    const first = resolveTemplateFieldOverlay({
      discovered,
      manifest: null,
      overlay: partitionFieldOverlay({ configured: [], discovered, overlay })
        .applied,
    });
    const second = resolveTemplateFieldOverlay({
      discovered,
      manifest: first,
      overlay: partitionFieldOverlay({
        configured: first.fields,
        discovered,
        overlay,
      }).applied,
    });

    expect(second).toEqual(first);
    expect(
      first.fields.find(({ path }) => path === "company")?.lookup?.formats,
    ).toHaveLength(3);
  });
});

describe("applyFieldOverlay", () => {
  test("new and embedded lookup configurations resolve the same manifest for storage and diagnostics", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}"),
    );
    const lookup = { path: "company", lookup: krsLookup("name") };
    const incoming = resolveTemplateFieldOverlay({
      discovered,
      manifest: null,
      overlay: [lookup],
    });
    const embedded = resolveTemplateFieldOverlay({
      discovered,
      manifest: incoming,
      overlay: undefined,
    });
    expect(incoming).toEqual(embedded);
    expect(incoming.fields).toEqual([expect.objectContaining(lookup)]);
    expect(incoming.fields.map(({ path }) => path)).toEqual(["company"]);
  });

  test("merges by path and appends a path the manifest does not carry", () => {
    const manifest = {
      version: 1,
      fields: [
        { path: "tenant", label: "Name" },
        { path: "signed_on", inputType: "date" as const },
      ],
    };

    expect(
      applyFieldOverlay(manifest, [
        { path: "signed_on", label: "Signature date" },
        { path: "company", lookup: krsLookup("name") },
      ]),
    ).toEqual({
      version: 1,
      fields: [
        { path: "tenant", label: "Name" },
        { path: "signed_on", inputType: "date", label: "Signature date" },
        { path: "company", lookup: krsLookup("name") },
      ],
    });
  });

  test("starts a manifest from the overlay when the template has none", () => {
    expect(applyFieldOverlay(null, [{ path: "fee", label: "Fee" }])).toEqual({
      version: 1,
      fields: [{ path: "fee", label: "Fee" }],
    });
  });
});
