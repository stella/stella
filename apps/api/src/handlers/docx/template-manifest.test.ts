import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { NamedCondition } from "@stll/template-conditions";

import {
  MANIFEST_NS,
  mergeManifestWithDiscovery,
  readManifest,
  stripManifest,
  writeManifest,
} from "./template-manifest";
import type { DiscoveredTemplate, TemplateManifest } from "./types";

// ── Helpers ──────────────────────────────────────────────

/** Create a minimal valid DOCX buffer (ZIP with document.xml). */
const createMinimalDocx = async (): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      "<w:body>",
      "<w:p><w:r><w:t>Hello</w:t></w:r></w:p>",
      "</w:body>",
      "</w:document>",
    ].join(""),
  );
  zip.file(
    "[Content_Types].xml",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      "</Types>",
    ].join(""),
  );
  const buf = await zip.generateAsync({
    type: "nodebuffer",
  });
  return Buffer.from(buf);
};

const sampleManifest: TemplateManifest = {
  version: 1,
  fields: [
    {
      path: "clientName",
      label: "Client Name",
      inputType: "text",
      required: true,
    },
    {
      path: "contractType",
      label: "Contract Type",
      inputType: "select",
      options: ["NDA", "SLA", "MSA"],
    },
    {
      path: "startDate",
      label: "Start Date",
      inputType: "date",
      validation: {
        required: true,
      },
    },
    {
      path: "description",
      label: "Description",
      inputType: "textarea",
      validation: {
        minLength: 10,
        maxLength: 500,
      },
    },
  ],
};

// ── readManifest ─────────────────────────────────────────

describe("readManifest", () => {
  test("returns null when no manifest exists", async () => {
    const docx = await createMinimalDocx();
    const result = await readManifest(docx);
    expect(result).toBeNull();
  });

  test("reads a manifest written by writeManifest", async () => {
    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, sampleManifest);
    const result = await readManifest(withManifest);

    expect(result).not.toBeNull();
    expect(result?.version).toBe(1);
    expect(result?.fields).toHaveLength(4);
  });

  test("parses field metadata correctly", async () => {
    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, sampleManifest);
    const result = await readManifest(withManifest);

    const clientField = result?.fields.find((f) => f.path === "clientName");
    expect(clientField).toBeDefined();
    expect(clientField?.label).toBe("Client Name");
    expect(clientField?.inputType).toBe("text");
    expect(clientField?.required).toBe(true);
  });

  test("parses select options correctly", async () => {
    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, sampleManifest);
    const result = await readManifest(withManifest);

    const contractField = result?.fields.find((f) => f.path === "contractType");
    expect(contractField?.inputType).toBe("select");
    expect(contractField?.options).toEqual(["NDA", "SLA", "MSA"]);
  });

  test("parses validation rules correctly", async () => {
    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, sampleManifest);
    const result = await readManifest(withManifest);

    const descField = result?.fields.find((f) => f.path === "description");
    expect(descField?.validation).toEqual({
      minLength: 10,
      maxLength: 500,
    });

    const dateField = result?.fields.find((f) => f.path === "startDate");
    expect(dateField?.validation).toEqual({
      required: true,
    });
  });

  test("round-trips a boolean condition-field's rule", async () => {
    const docx = await createMinimalDocx();
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "is_company",
          inputType: "boolean",
          condition: 'client_type == "company"',
        },
      ],
    };
    const withManifest = await writeManifest(docx, manifest);
    const result = await readManifest(withManifest);

    const field = result?.fields.find((f) => f.path === "is_company");
    expect(field?.inputType).toBe("boolean");
    expect(field?.condition).toBe('client_type == "company"');
  });

  test("preserves empty-string labels", async () => {
    const docx = await createMinimalDocx();
    const manifest: TemplateManifest = {
      version: 1,
      fields: [{ path: "field", label: "" }],
    };
    const withManifest = await writeManifest(docx, manifest);
    const result = await readManifest(withManifest);

    expect(result?.fields[0]?.label).toBe("");
  });

  test("falls back to default version for non-numeric attribute", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    );
    zip.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
    );
    zip.file(
      "customXml/item1.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<st:template xmlns:st="${MANIFEST_NS}" version="abc">` +
        "</st:template>",
    );
    const buf = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    const result = await readManifest(buf);
    expect(result).not.toBeNull();
    expect(result?.version).toBe(1);
  });

  test("preserves empty-string validation pattern", async () => {
    const docx = await createMinimalDocx();
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "field",
          validation: { pattern: "" },
        },
      ],
    };
    const withManifest = await writeManifest(docx, manifest);
    const result = await readManifest(withManifest);

    expect(result?.fields[0]?.validation?.pattern).toBe("");
  });

  test("skips NaN validation lengths", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    );
    zip.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
    );
    zip.file(
      "customXml/item1.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<st:template xmlns:st="${MANIFEST_NS}" version="1">` +
        "<st:fields>" +
        '<st:field path="f">' +
        '<st:validation minLength="abc" maxLength="xyz"/>' +
        "</st:field>" +
        "</st:fields>" +
        "</st:template>",
    );
    const buf = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    const result = await readManifest(buf);
    expect(result?.fields[0]?.validation).toBeUndefined();
  });

  test("returns null for non-stella custom XML", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    );
    zip.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
    );
    zip.file(
      "customXml/item1.xml",
      '<foo xmlns="urn:other:namespace"><bar/></foo>',
    );
    const buf = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    const result = await readManifest(buf);
    expect(result).toBeNull();
  });
});

// ── writeManifest ────────────────────────────────────────

describe("writeManifest", () => {
  test("creates custom XML part files", async () => {
    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, sampleManifest);

    const zip = await JSZip.loadAsync(withManifest);
    expect(zip.file("customXml/item1.xml")).not.toBeNull();
    expect(zip.file("customXml/itemProps1.xml")).not.toBeNull();
    expect(zip.file("customXml/_rels/item1.xml.rels")).not.toBeNull();
  });

  test("updates [Content_Types].xml", async () => {
    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, sampleManifest);

    const zip = await JSZip.loadAsync(withManifest);
    const ct = await zip.file("[Content_Types].xml")?.async("string");
    expect(ct).toContain("customXmlProperties");
  });

  test("throws when overwriting non-stella custom XML", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    );
    zip.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
    );
    zip.file(
      "customXml/item1.xml",
      '<foo xmlns="urn:other:namespace"><bar/></foo>',
    );
    const buf = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    expect(writeManifest(buf, sampleManifest)).rejects.toThrow(
      "non-stella custom XML",
    );
  });

  test("replaces existing manifest", async () => {
    const docx = await createMinimalDocx();
    const v1 = await writeManifest(docx, sampleManifest);

    const updatedManifest: TemplateManifest = {
      version: 1,
      fields: [{ path: "newField", label: "New Field" }],
    };
    const v2 = await writeManifest(v1, updatedManifest);

    const result = await readManifest(v2);
    expect(result?.fields).toHaveLength(1);
    expect(result?.fields[0]?.path).toBe("newField");
  });

  test("manifest XML contains correct namespace", async () => {
    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, sampleManifest);

    const zip = await JSZip.loadAsync(withManifest);
    const xml = await zip.file("customXml/item1.xml")?.async("string");
    expect(xml).toContain(MANIFEST_NS);
  });

  test("handles empty manifest", async () => {
    const docx = await createMinimalDocx();
    const empty: TemplateManifest = {
      version: 1,
      fields: [],
    };
    const withManifest = await writeManifest(docx, empty);

    const result = await readManifest(withManifest);
    expect(result).not.toBeNull();
    expect(result?.fields).toHaveLength(0);
  });

  test("escapes special XML characters", async () => {
    const docx = await createMinimalDocx();
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "field",
          label: 'Label with "quotes" & <brackets>',
        },
      ],
    };
    const withManifest = await writeManifest(docx, manifest);

    const result = await readManifest(withManifest);
    expect(result?.fields[0]?.label).toBe('Label with "quotes" & <brackets>');
  });

  test("handles validation with pattern", async () => {
    const docx = await createMinimalDocx();
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "email",
          validation: {
            required: true,
            pattern: "^[^@]+@[^@]+$",
          },
        },
      ],
    };
    const withManifest = await writeManifest(docx, manifest);

    const result = await readManifest(withManifest);
    expect(result?.fields[0]?.validation?.pattern).toBe("^[^@]+@[^@]+$");
  });
});

// ── stripManifest ────────────────────────────────────────

describe("stripManifest", () => {
  test("removes manifest from DOCX", async () => {
    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, sampleManifest);

    // Verify manifest exists
    expect(await readManifest(withManifest)).not.toBeNull();

    const stripped = await stripManifest(withManifest);

    // Verify manifest is gone
    expect(await readManifest(stripped)).toBeNull();
  });

  test("removes custom XML files from ZIP", async () => {
    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, sampleManifest);
    const stripped = await stripManifest(withManifest);

    const zip = await JSZip.loadAsync(stripped);
    expect(zip.file("customXml/item1.xml")).toBeNull();
    expect(zip.file("customXml/itemProps1.xml")).toBeNull();
    expect(zip.file("customXml/_rels/item1.xml.rels")).toBeNull();
  });

  test("cleans up [Content_Types].xml", async () => {
    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, sampleManifest);
    const stripped = await stripManifest(withManifest);

    const zip = await JSZip.loadAsync(stripped);
    const ct = await zip.file("[Content_Types].xml")?.async("string");
    expect(ct).not.toContain("customXmlProperties");
  });

  test("is a no-op on DOCX without manifest", async () => {
    const docx = await createMinimalDocx();
    const stripped = await stripManifest(docx);

    // Should return the same buffer
    expect(stripped).toBe(docx);
  });

  test("preserves non-stella custom XML", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    );
    zip.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
    );
    zip.file(
      "customXml/item1.xml",
      '<foo xmlns="urn:other:namespace"><bar/></foo>',
    );
    const buf = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    const stripped = await stripManifest(buf);

    // Non-Stella custom XML should be preserved
    expect(stripped).toBe(buf);
  });

  test("preserves document content", async () => {
    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, sampleManifest);
    const stripped = await stripManifest(withManifest);

    const zip = await JSZip.loadAsync(stripped);
    const xml = await zip.file("word/document.xml")?.async("string");
    expect(xml).toContain("Hello");
  });
});

// ── mergeManifestWithDiscovery ───────────────────────────

describe("mergeManifestWithDiscovery", () => {
  const baseDiscovery: DiscoveredTemplate = {
    placeholders: [
      { name: "clientName", count: 2 },
      { name: "date", count: 1 },
      { name: "amount", count: 1 },
    ],
    fields: [
      {
        path: "clientName",
        kind: "string",
        count: 2,
      },
      { path: "date", kind: "string", count: 1 },
      { path: "amount", kind: "string", count: 1 },
      {
        path: "showClause",
        kind: "boolean",
        count: 1,
      },
    ],
    structureErrors: [],
  };

  test("returns discovered fields when no manifest", () => {
    const resolved = mergeManifestWithDiscovery(null, baseDiscovery);
    expect(resolved).toHaveLength(4);
    expect(resolved[0]?.path).toBe("clientName");
    expect(resolved[0]?.kind).toBe("string");
    expect(resolved[0]?.count).toBe(2);
  });

  test("enriches discovered fields with manifest metadata", () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "clientName",
          label: "Client Name",
          inputType: "text",
          required: true,
        },
        {
          path: "date",
          label: "Contract Date",
          inputType: "date",
        },
      ],
    };

    const resolved = mergeManifestWithDiscovery(manifest, baseDiscovery);

    const clientField = resolved.find((f) => f.path === "clientName");
    expect(clientField?.label).toBe("Client Name");
    expect(clientField?.inputType).toBe("text");
    expect(clientField?.required).toBe(true);
    expect(clientField?.kind).toBe("string");
    expect(clientField?.count).toBe(2);

    const dateField = resolved.find((f) => f.path === "date");
    expect(dateField?.label).toBe("Contract Date");
    expect(dateField?.inputType).toBe("date");
  });

  test("includes manifest-only fields not found by discovery", () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "hiddenField",
          label: "Hidden",
          inputType: "text",
        },
      ],
    };

    const resolved = mergeManifestWithDiscovery(manifest, baseDiscovery);

    const hidden = resolved.find((f) => f.path === "hiddenField");
    expect(hidden).toBeDefined();
    expect(hidden?.label).toBe("Hidden");
    expect(hidden?.count).toBe(0);
  });

  test("threads formula through to resolved fields", () => {
    const discovery: DiscoveredTemplate = {
      placeholders: [],
      fields: [
        { path: "rent", kind: "string", count: 1 },
        { path: "rent_annual", kind: "string", count: 1 },
      ],
      structureErrors: [],
    };
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        { path: "rent_annual", formula: "rent * 12" },
        { path: "manifest_only", formula: "rent * 24" },
      ],
    };
    const resolved = mergeManifestWithDiscovery(manifest, discovery);
    const discoveredField = resolved.find((f) => f.path === "rent_annual");
    const manifestOnly = resolved.find((f) => f.path === "manifest_only");
    expect(discoveredField?.formula).toBe("rent * 12");
    expect(manifestOnly?.formula).toBe("rent * 24");
    expect(resolved.find((f) => f.path === "rent")?.formula).toBeUndefined();
  });

  test("drops namespace parents (a path that is only a prefix of others)", () => {
    const discovery: DiscoveredTemplate = {
      placeholders: [],
      fields: [
        { path: "tenant", kind: "object", count: 0 },
        { path: "tenant.name", kind: "string", count: 1 },
        { path: "tenant.krs", kind: "string", count: 1 },
        { path: "rent", kind: "string", count: 1 },
      ],
      structureErrors: [],
    };
    const resolved = mergeManifestWithDiscovery(null, discovery);
    expect(resolved.map((f) => f.path).sort()).toEqual([
      "rent",
      "tenant.krs",
      "tenant.name",
    ]);
  });

  test("keeps a lookup field as a leaf despite dotted format markers under it", () => {
    // {{company}} + {{company.full}} make discovery promote `company` to an
    // object and register `company.full` as a string. The lookup field is a
    // real leaf input, so it must survive the namespace-parent filter, and its
    // declared format markers must be dropped (rendered outputs, not inputs).
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "company",
          lookup: {
            registry: "krs",
            formats: [{ key: "full", template: "[company name], [seat]" }],
          },
        },
      ],
    };
    const discovery: DiscoveredTemplate = {
      placeholders: [],
      fields: [
        { path: "company", kind: "object", count: 1 },
        { path: "company.full", kind: "string", count: 1 },
      ],
      structureErrors: [],
    };
    const resolved = mergeManifestWithDiscovery(manifest, discovery);
    expect(resolved.map((f) => f.path)).toEqual(["company"]);
    expect(resolved.at(0)?.lookup?.formats).toEqual([
      { key: "full", template: "[company name], [seat]" },
    ]);
  });

  test("preserves discovered fields without manifest entries", () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "clientName",
          label: "Client Name",
        },
      ],
    };

    const resolved = mergeManifestWithDiscovery(manifest, baseDiscovery);

    const amount = resolved.find((f) => f.path === "amount");
    expect(amount).toBeDefined();
    expect(amount?.kind).toBe("string");
    expect(amount?.label).toBeUndefined();
  });

  test("preserves item fields for array types", () => {
    const discovery: DiscoveredTemplate = {
      placeholders: [],
      fields: [
        {
          path: "items",
          kind: "array",
          count: 1,
          itemFields: [
            {
              path: "name",
              kind: "string",
              count: 1,
            },
            {
              path: "price",
              kind: "string",
              count: 1,
            },
          ],
        },
      ],
      structureErrors: [],
    };

    const resolved = mergeManifestWithDiscovery(null, discovery);

    expect(resolved[0]?.itemFields).toHaveLength(2);
    expect(resolved[0]?.itemFields?.[0]?.path).toBe("name");
  });

  test("dotted manifest entries enrich array item fields without shadowing the array root", () => {
    const discovery: DiscoveredTemplate = {
      placeholders: [],
      fields: [
        {
          path: "lawyers",
          kind: "array",
          count: 1,
          itemFields: [{ path: "name", kind: "string", count: 1 }],
        },
      ],
      structureErrors: [],
    };
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "lawyers.name",
          label: "Lawyer name",
          inputType: "text",
          required: true,
        },
      ],
    };

    const resolved = mergeManifestWithDiscovery(manifest, discovery);

    // The array root must survive (a flat "lawyers.name" field would shadow
    // it in the namespace-parent filter and break the array fill form).
    expect(resolved).toHaveLength(1);
    const lawyers = resolved.at(0);
    expect(lawyers?.path).toBe("lawyers");
    expect(lawyers?.kind).toBe("array");
    const item = lawyers?.itemFields?.at(0);
    expect(item?.path).toBe("name");
    expect(item?.label).toBe("Lawyer name");
    expect(item?.inputType).toBe("text");
    expect(item?.required).toBe(true);
  });

  test("manifest entries under an array root never emit flat fields, even unplaced ones", () => {
    const discovery: DiscoveredTemplate = {
      placeholders: [],
      fields: [
        {
          path: "lawyers",
          kind: "array",
          count: 1,
          itemFields: [{ path: "name", kind: "string", count: 1 }],
        },
      ],
      structureErrors: [],
    };
    const manifest: TemplateManifest = {
      version: 1,
      fields: [{ path: "lawyers.email", label: "Email", inputType: "text" }],
    };

    const resolved = mergeManifestWithDiscovery(manifest, discovery);

    expect(resolved).toHaveLength(1);
    expect(resolved.at(0)?.path).toBe("lawyers");
    expect(resolved.at(0)?.kind).toBe("array");
  });

  test("merge preserves empty-string label from manifest", () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [{ path: "clientName", label: "" }],
    };

    const resolved = mergeManifestWithDiscovery(manifest, baseDiscovery);

    const clientField = resolved.find((f) => f.path === "clientName");
    expect(clientField?.label).toBe("");
  });

  test("manifest select options are preserved", () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "amount",
          label: "Amount",
          inputType: "select",
          options: ["100", "200", "500"],
        },
      ],
    };

    const resolved = mergeManifestWithDiscovery(manifest, baseDiscovery);

    const amount = resolved.find((f) => f.path === "amount");
    expect(amount?.inputType).toBe("select");
    expect(amount?.options).toEqual(["100", "200", "500"]);
  });
});

// ── Named conditions integration ─────────────────────────

describe("named conditions in fillTemplate", () => {
  test("evaluateCondition resolves named conditions", async () => {
    const { evaluateCondition } = await import("./block-directives");

    const conditions: NamedCondition[] = [
      {
        name: "HasNDA",
        expression: 'contractType == "NDA"',
      },
    ];

    const data = { contractType: "NDA" };
    expect(evaluateCondition("HasNDA", data, conditions)).toBe(true);

    const data2 = { contractType: "SLA" };
    expect(evaluateCondition("HasNDA", data2, conditions)).toBe(false);
  });

  test("named condition falls back to normal evaluation", async () => {
    const { evaluateCondition } = await import("./block-directives");

    const conditions: NamedCondition[] = [
      {
        name: "HasNDA",
        expression: "contractType",
      },
    ];

    // Expression that doesn't match any named condition
    const data = { showSection: true };
    expect(evaluateCondition("showSection", data, conditions)).toBe(true);
  });

  test("named conditions work without namedConditions param", async () => {
    const { evaluateCondition } = await import("./block-directives");

    const data = { active: true };
    expect(evaluateCondition("active", data)).toBe(true);
    expect(evaluateCondition("active", data)).toBe(true);
  });

  test("circular named conditions return false", async () => {
    const { evaluateCondition } = await import("./block-directives");

    const conditions: NamedCondition[] = [
      { name: "A", expression: "B" },
      { name: "B", expression: "A" },
    ];

    const data = {};
    expect(evaluateCondition("A", data, conditions)).toBe(false);
  });

  test("named conditions resolve in negated expressions", async () => {
    const { evaluateCondition } = await import("./block-directives");

    const conditions: NamedCondition[] = [
      {
        name: "HasNDA",
        expression: 'contractType == "NDA"',
      },
    ];

    const data = { contractType: "NDA" };
    expect(evaluateCondition("!HasNDA", data, conditions)).toBe(false);

    const data2 = { contractType: "SLA" };
    expect(evaluateCondition("!HasNDA", data2, conditions)).toBe(true);
  });

  test("named conditions resolve in compound expressions", async () => {
    const { evaluateCondition } = await import("./block-directives");

    const conditions: NamedCondition[] = [
      {
        name: "HasNDA",
        expression: 'contractType == "NDA"',
      },
    ];

    const data = { contractType: "NDA", isActive: true };
    expect(evaluateCondition("HasNDA and isActive", data, conditions)).toBe(
      true,
    );

    const data2 = { contractType: "SLA", isActive: true };
    expect(evaluateCondition("HasNDA or isActive", data2, conditions)).toBe(
      true,
    );
    expect(evaluateCondition("HasNDA and isActive", data2, conditions)).toBe(
      false,
    );
  });
  test("shared sub-conditions don't trigger false circular detection", async () => {
    const { evaluateCondition } = await import("./block-directives");

    // IsNDA is used by both IsPremium (directly) and
    // IsLongTerm (indirectly). The _resolved set must not
    // leak across sibling resolutions.
    const conditions: NamedCondition[] = [
      {
        name: "IsPremium",
        expression: "IsNDA and IsLongTerm",
      },
      {
        name: "IsNDA",
        expression: 'contractType == "NDA"',
      },
      {
        name: "IsLongTerm",
        expression: "IsNDA and duration > 12",
      },
    ];

    const data = { contractType: "NDA", duration: 24 };
    expect(evaluateCondition("IsPremium", data, conditions)).toBe(true);

    const data2 = { contractType: "NDA", duration: 6 };
    expect(evaluateCondition("IsPremium", data2, conditions)).toBe(false);
  });
});

// ── Round-trip ───────────────────────────────────────────

describe("round-trip", () => {
  test("write → read → strip → read returns null", async () => {
    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, sampleManifest);

    // Read back
    const readBack = await readManifest(withManifest);
    expect(readBack?.version).toBe(1);
    expect(readBack?.fields).toHaveLength(4);

    // Strip
    const stripped = await stripManifest(withManifest);
    const afterStrip = await readManifest(stripped);
    expect(afterStrip).toBeNull();
  });

  test("composite parts + format round-trip", async () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "lawyer",
          label: "Lawyer",
          parts: [
            {
              key: "position",
              label: "Position",
              inputType: "select",
              options: ["rad. praw.", "adw."],
            },
            { key: "name", inputType: "text", pattern: "\\p{Lu}.+" },
          ],
          format: "{{position}} {{name}}",
        },
      ],
    };

    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, manifest);
    const readBack = await readManifest(withManifest);

    const field = readBack?.fields.find((f) => f.path === "lawyer");
    expect(field?.format).toBe("{{position}} {{name}}");
    expect(field?.parts).toEqual([
      {
        key: "position",
        label: "Position",
        inputType: "select",
        options: ["rad. praw.", "adw."],
      },
      { key: "name", inputType: "text", pattern: "\\p{Lu}.+" },
    ]);
  });

  test("optionsFrom round-trips; an invalid value is dropped on read", async () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "lead_party",
          inputType: "select",
          options: ["Acme"],
          optionsFrom: "parties.name",
        },
      ],
    };

    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, manifest);
    const readBack = await readManifest(withManifest);
    expect(readBack?.fields.at(0)?.optionsFrom).toBe("parties.name");

    // Hand-edited XML with a non-path value must not leak past the parser.
    const tampered = await writeManifest(docx, {
      ...manifest,
      fields: [{ path: "lead_party", optionsFrom: "bad path!" }],
    });
    const tamperedBack = await readManifest(tampered);
    expect(tamperedBack?.fields.at(0)?.optionsFrom).toBeUndefined();
  });

  test("optionsFrom survives mergeManifestWithDiscovery", async () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        { path: "lead_party", inputType: "select", optionsFrom: "parties" },
        { path: "manifest_only", optionsFrom: "parties" },
      ],
    };
    const discovered: DiscoveredTemplate = {
      placeholders: [{ name: "lead_party", count: 1 }],
      fields: [{ path: "lead_party", kind: "string", count: 1 }],
      structureErrors: [],
    };

    const resolved = mergeManifestWithDiscovery(manifest, discovered);
    const discoveredField = resolved.find((f) => f.path === "lead_party");
    const manifestOnly = resolved.find((f) => f.path === "manifest_only");
    expect(discoveredField?.optionsFrom).toBe("parties");
    expect(manifestOnly?.optionsFrom).toBe("parties");
  });

  test("lookup round-trips; an unsupported registry is dropped on read", async () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "buyer_krs",
          lookup: {
            registry: "krs",
            formats: [
              {
                key: "output_1",
                template: "[name], with its seat in [seat], KRS [number]",
              },
            ],
          },
        },
        {
          path: "seller_krs",
          lookup: {
            registry: "krs",
            formats: [{ key: "output_1", template: "[name]" }],
          },
        },
      ],
    };

    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, manifest);
    const readBack = await readManifest(withManifest);
    expect(readBack?.fields.at(0)?.lookup).toEqual({
      registry: "krs",
      formats: [
        {
          key: "output_1",
          template: "[name], with its seat in [seat], KRS [number]",
        },
      ],
    });
    expect(readBack?.fields.at(1)?.lookup).toEqual({
      registry: "krs",
      formats: [{ key: "output_1", template: "[name]" }],
    });

    // Hand-edited XML with a registry outside the supported set must not
    // leak past the parser.
    const zip = await JSZip.loadAsync(withManifest);
    const itemEntry = zip.file("customXml/item1.xml");
    const itemXml = await itemEntry?.async("string");
    zip.file(
      "customXml/item1.xml",
      (itemXml ?? "").replaceAll('registry="krs"', 'registry="unknown"'),
    );
    const tampered = Buffer.from(
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    const tamperedBack = await readManifest(tampered);
    expect(tamperedBack?.fields.at(0)?.lookup).toBeUndefined();
    expect(tamperedBack?.fields.at(1)?.lookup).toBeUndefined();
  });

  test("lookup named formats round-trip; an out-of-grammar key is dropped on read", async () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "company",
          lookup: {
            registry: "krs",
            formats: [
              { key: "output_1", template: "[company name]" },
              { key: "full", template: "[company name], seat in [seat]" },
              { key: "short", template: "**[company name]**" },
            ],
          },
        },
      ],
    };

    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, manifest);
    const readBack = await readManifest(withManifest);
    expect(readBack?.fields.at(0)?.lookup).toEqual({
      registry: "krs",
      formats: [
        { key: "output_1", template: "[company name]" },
        { key: "full", template: "[company name], seat in [seat]" },
        { key: "short", template: "**[company name]**" },
      ],
    });

    // Hand-edited XML with a dotted key (illegal segment) must not leak past
    // the parser; the surviving valid format still round-trips.
    const zip = await JSZip.loadAsync(withManifest);
    const itemEntry = zip.file("customXml/item1.xml");
    const itemXml = await itemEntry?.async("string");
    zip.file(
      "customXml/item1.xml",
      (itemXml ?? "").replaceAll('key="short"', 'key="bad.key"'),
    );
    const tampered = Buffer.from(
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    const tamperedBack = await readManifest(tampered);
    expect(tamperedBack?.fields.at(0)?.lookup?.formats).toEqual([
      { key: "output_1", template: "[company name]" },
      { key: "full", template: "[company name], seat in [seat]" },
    ]);
  });

  test("formula round-trips; a hand-edited formula beside another value source is dropped", async () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "rent_indexed",
          label: "Indexed rent",
          formula: "min(rent * (1 + index / 100), rent * 1.05)",
        },
        {
          path: "seller_krs",
          lookup: {
            registry: "krs",
            formats: [{ key: "output_1", template: "[name]" }],
          },
        },
      ],
    };

    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, manifest);
    const readBack = await readManifest(withManifest);
    expect(readBack?.fields.at(0)?.formula).toBe(
      "min(rent * (1 + index / 100), rent * 1.05)",
    );
    expect(readBack?.fields.at(0)?.label).toBe("Indexed rent");
    expect(readBack?.fields.at(1)?.formula).toBeUndefined();

    // Hand-edited XML putting a formula on a lookup field (formula is
    // mutually exclusive with the other value sources) must not leak past
    // the parser.
    const zip = await JSZip.loadAsync(withManifest);
    const itemEntry = zip.file("customXml/item1.xml");
    const itemXml = await itemEntry?.async("string");
    zip.file(
      "customXml/item1.xml",
      (itemXml ?? "").replace(
        'path="seller_krs"',
        'path="seller_krs" formula="rent * 2"',
      ),
    );
    const tampered = Buffer.from(
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    const tamperedBack = await readManifest(tampered);
    expect(tamperedBack?.fields.at(1)?.formula).toBeUndefined();
    expect(tamperedBack?.fields.at(1)?.lookup).toEqual({
      registry: "krs",
      formats: [{ key: "output_1", template: "[name]" }],
    });
  });

  test("dateFormat round-trips; a hand-edited implausible locale is dropped", async () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "signature_date",
          inputType: "date",
          dateFormat: { locale: "cs", style: "long" },
        },
        { path: "valid_until", inputType: "date" },
      ],
    };

    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, manifest);
    const readBack = await readManifest(withManifest);
    expect(readBack?.fields.at(0)?.dateFormat).toEqual({
      locale: "cs",
      style: "long",
    });
    expect(readBack?.fields.at(0)?.inputType).toBe("date");
    expect(readBack?.fields.at(1)?.dateFormat).toBeUndefined();

    // Hand-edited XML with a structurally invalid BCP-47 tag must not leak
    // past the parser (Intl.DateTimeFormat would throw on it at fill time).
    const zip = await JSZip.loadAsync(withManifest);
    const itemEntry = zip.file("customXml/item1.xml");
    const itemXml = await itemEntry?.async("string");
    zip.file(
      "customXml/item1.xml",
      (itemXml ?? "").replace('locale="cs"', 'locale="not a locale"'),
    );
    const tampered = Buffer.from(
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    const tamperedBack = await readManifest(tampered);
    expect(tamperedBack?.fields.at(0)?.dateFormat).toBeUndefined();
  });

  test("hint round-trips and survives mergeManifestWithDiscovery", async () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "company.krs",
          hint: 'KRS <number> from the "register"',
        },
        { path: "company.name" },
      ],
    };

    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, manifest);
    const readBack = await readManifest(withManifest);
    expect(readBack?.fields.at(0)?.hint).toBe(
      'KRS <number> from the "register"',
    );
    expect(readBack?.fields.at(1)?.hint).toBeUndefined();

    const discovered: DiscoveredTemplate = {
      placeholders: [{ name: "company.krs", count: 1 }],
      fields: [{ path: "company.krs", kind: "string", count: 1 }],
      structureErrors: [],
    };
    const resolved = mergeManifestWithDiscovery(manifest, discovered);
    expect(resolved.find((f) => f.path === "company.krs")?.hint).toBe(
      'KRS <number> from the "register"',
    );
    expect(
      resolved.find((f) => f.path === "company.name")?.hint,
    ).toBeUndefined();
  });

  test("dateFormat survives mergeManifestWithDiscovery", () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "signature_date",
          inputType: "date",
          dateFormat: { locale: "cs", style: "long" },
        },
        {
          path: "manifest_only",
          inputType: "date",
          dateFormat: { locale: "de", style: "medium" },
        },
      ],
    };
    const discovered: DiscoveredTemplate = {
      placeholders: [{ name: "signature_date", count: 1 }],
      fields: [{ path: "signature_date", kind: "string", count: 1 }],
      structureErrors: [],
    };

    const resolved = mergeManifestWithDiscovery(manifest, discovered);
    const discoveredField = resolved.find((f) => f.path === "signature_date");
    const manifestOnly = resolved.find((f) => f.path === "manifest_only");
    expect(discoveredField?.dateFormat).toEqual({
      locale: "cs",
      style: "long",
    });
    expect(manifestOnly?.dateFormat).toEqual({ locale: "de", style: "medium" });
  });

  test("lookup survives mergeManifestWithDiscovery", async () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "buyer_krs",
          lookup: {
            registry: "krs",
            formats: [{ key: "output_1", template: "fmt" }],
          },
        },
        {
          path: "manifest_only",
          lookup: {
            registry: "krs",
            formats: [{ key: "output_1", template: "[name]" }],
          },
        },
      ],
    };
    const discovered: DiscoveredTemplate = {
      placeholders: [{ name: "buyer_krs", count: 1 }],
      fields: [{ path: "buyer_krs", kind: "string", count: 1 }],
      structureErrors: [],
    };

    const resolved = mergeManifestWithDiscovery(manifest, discovered);
    const discoveredField = resolved.find((f) => f.path === "buyer_krs");
    const manifestOnly = resolved.find((f) => f.path === "manifest_only");
    expect(discoveredField?.lookup).toEqual({
      registry: "krs",
      formats: [{ key: "output_1", template: "fmt" }],
    });
    expect(manifestOnly?.lookup).toEqual({
      registry: "krs",
      formats: [{ key: "output_1", template: "[name]" }],
    });
  });

  test("composite parts survive mergeManifestWithDiscovery", async () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "lawyer",
          parts: [{ key: "name", inputType: "text" }],
          format: "{{name}}",
        },
      ],
    };
    const discovered: DiscoveredTemplate = {
      placeholders: [{ name: "lawyer", count: 1 }],
      fields: [{ path: "lawyer", kind: "string", count: 1 }],
      structureErrors: [],
    };

    const resolved = mergeManifestWithDiscovery(manifest, discovered);
    expect(resolved[0]?.parts).toEqual([{ key: "name", inputType: "text" }]);
    expect(resolved[0]?.format).toBe("{{name}}");
  });

  test("write → strip → write creates fresh manifest", async () => {
    const docx = await createMinimalDocx();
    const v1 = await writeManifest(docx, sampleManifest);
    const stripped = await stripManifest(v1);

    const newManifest: TemplateManifest = {
      version: 1,
      fields: [{ path: "fresh" }],
    };
    const v2 = await writeManifest(stripped, newManifest);

    const result = await readManifest(v2);
    expect(result?.fields).toHaveLength(1);
    expect(result?.fields[0]?.path).toBe("fresh");
  });
});
