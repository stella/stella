import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  MANIFEST_NS,
  mergeManifestWithDiscovery,
  readManifest,
  stripManifest,
  writeManifest,
} from "./template-manifest";
import type {
  DiscoveredTemplate,
  NamedCondition,
  TemplateManifest,
} from "./types";

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
  conditions: [
    {
      name: "HasNDA",
      expression: 'contractType == "NDA"',
      label: "NDA selected",
    },
    {
      name: "IsLongTerm",
      expression: "duration > 12",
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
    expect(result?.conditions).toHaveLength(2);
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

  test("parses named conditions correctly", async () => {
    const docx = await createMinimalDocx();
    const withManifest = await writeManifest(docx, sampleManifest);
    const result = await readManifest(withManifest);

    const ndaCond = result?.conditions.find((c) => c.name === "HasNDA");
    expect(ndaCond).toBeDefined();
    expect(ndaCond?.expression).toBe('contractType == "NDA"');
    expect(ndaCond?.label).toBe("NDA selected");

    const longTerm = result?.conditions.find((c) => c.name === "IsLongTerm");
    expect(longTerm?.expression).toBe("duration > 12");
    expect(longTerm?.label).toBeUndefined();
  });

  test("preserves empty-string labels", async () => {
    const docx = await createMinimalDocx();
    const manifest: TemplateManifest = {
      version: 1,
      fields: [{ path: "field", label: "" }],
      conditions: [{ name: "cond", expression: "x", label: "" }],
    };
    const withManifest = await writeManifest(docx, manifest);
    const result = await readManifest(withManifest);

    expect(result?.fields[0]?.label).toBe("");
    expect(result?.conditions[0]?.label).toBe("");
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
      conditions: [],
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
      conditions: [],
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
      conditions: [],
    };
    const withManifest = await writeManifest(docx, empty);

    const result = await readManifest(withManifest);
    expect(result).not.toBeNull();
    expect(result?.fields).toHaveLength(0);
    expect(result?.conditions).toHaveLength(0);
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
      conditions: [],
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
      conditions: [],
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
      conditions: [],
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
      conditions: [],
    };

    const resolved = mergeManifestWithDiscovery(manifest, baseDiscovery);

    const hidden = resolved.find((f) => f.path === "hiddenField");
    expect(hidden).toBeDefined();
    expect(hidden?.label).toBe("Hidden");
    expect(hidden?.count).toBe(0);
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
      conditions: [],
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

  test("merge preserves empty-string label from manifest", () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [{ path: "clientName", label: "" }],
      conditions: [],
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
      conditions: [],
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
    expect(readBack?.conditions).toHaveLength(2);

    // Strip
    const stripped = await stripManifest(withManifest);
    const afterStrip = await readManifest(stripped);
    expect(afterStrip).toBeNull();
  });

  test("write → strip → write creates fresh manifest", async () => {
    const docx = await createMinimalDocx();
    const v1 = await writeManifest(docx, sampleManifest);
    const stripped = await stripManifest(v1);

    const newManifest: TemplateManifest = {
      version: 1,
      fields: [{ path: "fresh" }],
      conditions: [],
    };
    const v2 = await writeManifest(stripped, newManifest);

    const result = await readManifest(v2);
    expect(result?.fields).toHaveLength(1);
    expect(result?.fields[0]?.path).toBe("fresh");
  });
});
