import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { ScopedDb } from "@/api/db";
import { discoverTemplate } from "@/api/handlers/docx/discover-template";
import { extractText } from "@/api/handlers/docx/extract-text";
import { fillTemplate } from "@/api/handlers/docx/patch-template";
import {
  mergeManifestWithDiscovery,
  readManifest,
  writeManifest,
} from "@/api/handlers/docx/template-manifest";
import type { TemplateManifest } from "@/api/handlers/docx/types";
import { discoverHandler } from "@/api/handlers/templates/discover";
import { fillHandler } from "@/api/handlers/templates/fill";
import { manifestHandler } from "@/api/handlers/templates/manifest";
import { toSafeId } from "@/api/lib/branded-types";

// ── Helpers ──────────────────────────────────────────────

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org` +
  `/wordprocessingml/2006/main">` +
  `<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

const makeDocx = async (documentXml: string): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  zip.file(
    "[Content_Types].xml",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org',
      '/package/2006/content-types">',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Default Extension="rels"',
      ' ContentType="application/vnd.openxmlformats',
      '-package.relationships+xml"/>',
      "</Types>",
    ].join(""),
  );
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

const makeEmptyDocx = async () => makeDocx(WRAP(P("Hello")));

const WRAP_HDR = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:hdr xmlns:w="http://schemas.openxmlformats.org` +
  `/wordprocessingml/2006/main">${body}</w:hdr>`;

const WRAP_FTR = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:ftr xmlns:w="http://schemas.openxmlformats.org` +
  `/wordprocessingml/2006/main">${body}</w:ftr>`;

/**
 * Create a DOCX with headers and/or footers alongside the
 * main document body.
 */
const makeDocxWithParts = async (opts: {
  documentXml: string;
  headers?: Record<string, string>;
  footers?: Record<string, string>;
}): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", opts.documentXml);
  if (opts.headers) {
    for (const [name, xml] of Object.entries(opts.headers)) {
      zip.file(`word/${name}`, xml);
    }
  }
  if (opts.footers) {
    for (const [name, xml] of Object.entries(opts.footers)) {
      zip.file(`word/${name}`, xml);
    }
  }
  zip.file(
    "[Content_Types].xml",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org',
      '/package/2006/content-types">',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Default Extension="rels"',
      ' ContentType="application/vnd.openxmlformats',
      '-package.relationships+xml"/>',
      "</Types>",
    ].join(""),
  );
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

// prettier-ignore
const DOCX_MIME =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const fakeOrgId = toSafeId<"organization">("org_test");
const fakeUserId = "user_test";

/** No-op ScopedDb stub for tests. Calls the callback but
 *  returns `undefined`; sufficient for handlers where the
 *  scopedDb call is best-effort (e.g., analytics inserts). */
// SAFETY: test stub; shape satisfies ScopedDb interface for handler mocks
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const stubScopedDb = (async (fn: unknown) => {
  if (typeof fn === "function") {
    // Swallow the result; the callback runs against a
    // fake tx that will throw on actual DB access.
    return;
  }
  return;
}) as unknown as ScopedDb;

const makeDocxFile = async (buf: Buffer) =>
  new File([new Uint8Array(buf)], "test.docx", { type: DOCX_MIME });

const sampleManifest: TemplateManifest = {
  version: 1,
  fields: [
    {
      path: "clientName",
      label: "Client Name",
      inputType: "text",
      required: true,
    },
  ],
  conditions: [
    {
      name: "hasGuarantor",
      expression: "has_guarantor",
      label: "Has Guarantor?",
    },
  ],
};

// ── Discover ─────────────────────────────────────────────

describe("template discover", () => {
  test("discovers placeholders from valid DOCX", async () => {
    const xml = WRAP([P("Name: {{name}}"), P("City: {{city}}")].join(""));
    const buf = await makeDocx(xml);

    const discovered = await discoverTemplate(buf);
    const manifest = await readManifest(buf);
    const fields = mergeManifestWithDiscovery(manifest, discovered);

    expect(fields.length).toBe(2);
    const names = fields.map((f) => f.path).toSorted();
    expect(names).toEqual(["city", "name"]);
    expect(discovered.structureErrors).toEqual([]);
  });

  test("returns merged fields when manifest is embedded", async () => {
    const xml = WRAP(P("Client: {{clientName}}"));
    let buf = await makeDocx(xml);
    buf = await writeManifest(buf, sampleManifest);

    const discovered = await discoverTemplate(buf);
    const manifest = await readManifest(buf);
    const fields = mergeManifestWithDiscovery(manifest, discovered);

    const clientField = fields.find((f) => f.path === "clientName");
    expect(clientField).toBeDefined();
    expect(clientField?.label).toBe("Client Name");
    expect(clientField?.inputType).toBe("text");
    expect(clientField?.required).toBe(true);
  });

  test("returns empty fields for DOCX with no placeholders", async () => {
    const buf = await makeEmptyDocx();
    const discovered = await discoverTemplate(buf);
    const manifest = await readManifest(buf);
    const fields = mergeManifestWithDiscovery(manifest, discovered);

    expect(fields).toEqual([]);
    expect(discovered.structureErrors).toEqual([]);
  });

  test("returns conditions from manifest", async () => {
    let buf = await makeEmptyDocx();
    buf = await writeManifest(buf, sampleManifest);

    const manifest = await readManifest(buf);
    expect(manifest).not.toBeNull();
    expect(manifest?.conditions).toHaveLength(1);
    expect(manifest?.conditions[0]?.name).toBe("hasGuarantor");
  });

  test("discovers placeholders in headers", async () => {
    const buf = await makeDocxWithParts({
      documentXml: WRAP(P("Body: {{bodyField}}")),
      headers: {
        "header1.xml": WRAP_HDR(P("Client: {{clientName}}")),
      },
    });

    const discovered = await discoverTemplate(buf);
    const names = discovered.placeholders.map((p) => p.name).toSorted();
    expect(names).toEqual(["bodyField", "clientName"]);
    expect(discovered.fields.length).toBe(2);
  });

  test("discovers placeholders in footers", async () => {
    const buf = await makeDocxWithParts({
      documentXml: WRAP(P("Body: {{bodyField}}")),
      footers: {
        "footer1.xml": WRAP_FTR(P("Page {{pageNum}}")),
      },
    });

    const discovered = await discoverTemplate(buf);
    const names = discovered.placeholders.map((p) => p.name).toSorted();
    expect(names).toEqual(["bodyField", "pageNum"]);
  });

  test("deduplicates across body and header", async () => {
    const buf = await makeDocxWithParts({
      documentXml: WRAP(P("Name: {{name}}")),
      headers: {
        "header1.xml": WRAP_HDR(P("Name: {{name}}")),
      },
    });

    const discovered = await discoverTemplate(buf);
    expect(discovered.placeholders.length).toBe(1);
    expect(discovered.placeholders[0]?.name).toBe("name");
    // Count should be 2 (one in body, one in header)
    expect(discovered.placeholders[0]?.count).toBe(2);
  });

  test("discovers from multiple headers and footers", async () => {
    const buf = await makeDocxWithParts({
      documentXml: WRAP(P("Body")),
      headers: {
        "header1.xml": WRAP_HDR(P("{{h1}}")),
        "header2.xml": WRAP_HDR(P("{{h2}}")),
      },
      footers: {
        "footer1.xml": WRAP_FTR(P("{{f1}}")),
      },
    });

    const discovered = await discoverTemplate(buf);
    const names = discovered.placeholders.map((p) => p.name).toSorted();
    expect(names).toEqual(["f1", "h1", "h2"]);
  });
});

// ── Extract text (headers/footers) ───────────────────────

describe("extractText with headers and footers", () => {
  test("extracts paragraphs from header, body, footer", async () => {
    const buf = await makeDocxWithParts({
      documentXml: WRAP(P("Body text")),
      headers: {
        "header1.xml": WRAP_HDR(P("Header text")),
      },
      footers: {
        "footer1.xml": WRAP_FTR(P("Footer text")),
      },
    });

    const result = await extractText(buf);
    expect(result.paragraphs.length).toBe(3);

    const header = result.paragraphs.find((p) => p.source === "header");
    const body = result.paragraphs.find((p) => p.source === "body");
    const footer = result.paragraphs.find((p) => p.source === "footer");

    expect(header?.text).toBe("Header text");
    expect(body?.text).toBe("Body text");
    expect(footer?.text).toBe("Footer text");
  });

  test("orders headers before body before footers", async () => {
    const buf = await makeDocxWithParts({
      documentXml: WRAP(P("Body")),
      headers: {
        "header1.xml": WRAP_HDR(P("H1")),
      },
      footers: {
        "footer1.xml": WRAP_FTR(P("F1")),
      },
    });

    const result = await extractText(buf);
    const sources = result.paragraphs.map((p) => p.source);
    expect(sources).toEqual(["header", "body", "footer"]);
  });

  test("assigns sequential indices across sections", async () => {
    const buf = await makeDocxWithParts({
      documentXml: WRAP([P("Body 1"), P("Body 2")].join("")),
      headers: {
        "header1.xml": WRAP_HDR(P("Header")),
      },
    });

    const result = await extractText(buf);
    const indices = result.paragraphs.map((p) => p.index);
    expect(indices).toEqual([0, 1, 2]);
  });
});

// ── Fill ─────────────────────────────────────────────────

describe("template fill", () => {
  test("fills simple placeholders successfully", async () => {
    const xml = WRAP([P("Name: {{name}}"), P("Date: {{date}}")].join(""));
    const buf = await makeDocx(xml);

    const result = await fillTemplate(buf, {
      name: "Alice",
      date: "2026-01-15",
    });

    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.length).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(result.buffer);
    const docXml = await zip.file("word/document.xml")?.async("string");
    expect(docXml).toContain("Alice");
    expect(docXml).toContain("2026-01-15");
    expect(result.unmatchedPlaceholders).toEqual([]);
    expect(result.unusedValues).toEqual([]);
  });

  test("reports unmatched placeholders", async () => {
    const xml = WRAP(
      [P("Name: {{name}}"), P("City: {{city}}"), P("Phone: {{phone}}")].join(
        "",
      ),
    );
    const buf = await makeDocx(xml);

    const result = await fillTemplate(buf, { name: "Alice" });

    expect(result.unmatchedPlaceholders).toContain("city");
    expect(result.unmatchedPlaceholders).toContain("phone");
  });

  test("reports unused values", async () => {
    const xml = WRAP(P("Name: {{name}}"));
    const buf = await makeDocx(xml);

    const result = await fillTemplate(buf, {
      name: "Alice",
      extra: "not used",
    });

    expect(result.unusedValues).toContain("extra");
  });

  test("returns structure errors for mismatched blocks", async () => {
    const xml = WRAP(
      [P("{{#if show}}"), P("Content"), P("{{/each}}")].join(""),
    );
    const buf = await makeDocx(xml);

    const result = await fillTemplate(buf, { show: true });
    expect(result.structureErrors.length).toBeGreaterThan(0);
  });
});

// ── Manifest ─────────────────────────────────────────────

describe("template manifest", () => {
  test("embeds manifest into DOCX successfully", async () => {
    const buf = await makeEmptyDocx();
    const result = await writeManifest(buf, sampleManifest);

    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(result);
    const customXml = zip.file("customXml/item1.xml");
    expect(customXml).not.toBeNull();
  });

  test("round-trip: write then read manifest", async () => {
    const buf = await makeEmptyDocx();
    const written = await writeManifest(buf, sampleManifest);
    const read = await readManifest(written);

    expect(read).not.toBeNull();
    expect(read?.version).toBe(1);
    expect(read?.fields).toHaveLength(1);
    expect(read?.fields[0]?.path).toBe("clientName");
    expect(read?.fields[0]?.label).toBe("Client Name");
    expect(read?.conditions).toHaveLength(1);
    expect(read?.conditions[0]?.name).toBe("hasGuarantor");
  });

  test("returns null for DOCX without manifest", async () => {
    const buf = await makeEmptyDocx();
    const manifest = await readManifest(buf);
    expect(manifest).toBeNull();
  });

  test("rejects fields with non-object elements", async () => {
    const buf = await makeEmptyDocx();
    const file = await makeDocxFile(buf);
    const result = await manifestHandler({
      organizationId: fakeOrgId,
      body: {
        file,
        manifest: JSON.stringify({
          version: 1,
          fields: [null, "bad"],
          conditions: [],
        }),
      },
    });

    expect(result).toBeInstanceOf(Response);
    const resp = result;
    expect(resp.status).toBe(400);
    // SAFETY: test asserts 400; response body shape is known
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("'path'");
  });

  test("rejects conditions with missing properties", async () => {
    const buf = await makeEmptyDocx();
    const file = await makeDocxFile(buf);
    const result = await manifestHandler({
      organizationId: fakeOrgId,
      body: {
        file,
        manifest: JSON.stringify({
          version: 1,
          fields: [],
          conditions: [{ name: "x" }],
        }),
      },
    });

    expect(result).toBeInstanceOf(Response);
    const resp = result;
    expect(resp.status).toBe(400);
    // SAFETY: test asserts 400; response body shape is known
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("'expression'");
  });

  test("overwrites existing Stella manifest", async () => {
    const buf = await makeEmptyDocx();
    const first = await writeManifest(buf, sampleManifest);

    const updated: TemplateManifest = {
      version: 1,
      fields: [{ path: "newField", label: "New Field" }],
      conditions: [],
    };
    const second = await writeManifest(first, updated);
    const read = await readManifest(second);

    expect(read?.fields).toHaveLength(1);
    expect(read?.fields[0]?.path).toBe("newField");
    expect(read?.conditions).toHaveLength(0);
  });
});

// ── Handler: MIME validation ─────────────────────────────

describe("handler MIME validation", () => {
  const pdfFile = new File(
    [new Uint8Array([0x25, 0x50, 0x44, 0x46])],
    "test.pdf",
    { type: "application/pdf" },
  );

  test("discover rejects non-DOCX file", async () => {
    const result = await discoverHandler({
      organizationId: fakeOrgId,
      body: { file: pdfFile },
    });

    expect(result).toBeInstanceOf(Response);
    // SAFETY: test asserts Response; toBeInstanceOf narrows at runtime
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const resp = result as Response;
    expect(resp.status).toBe(400);
    // SAFETY: test asserts 400; response body shape is known
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("DOCX");
  });

  test("fill rejects non-DOCX file", async () => {
    const result = await fillHandler({
      scopedDb: stubScopedDb,
      organizationId: fakeOrgId,
      userId: fakeUserId,
      query: {},
      body: { file: pdfFile, values: "{}" },
    });

    expect(result).toBeInstanceOf(Response);
    const resp = result;
    expect(resp.status).toBe(400);
    // SAFETY: test asserts 400; response body shape is known
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("DOCX");
  });

  test("manifest rejects non-DOCX file", async () => {
    const result = await manifestHandler({
      organizationId: fakeOrgId,
      body: {
        file: pdfFile,
        manifest: JSON.stringify({
          version: 1,
          fields: [],
          conditions: [],
        }),
      },
    });

    expect(result).toBeInstanceOf(Response);
    const resp = result;
    expect(resp.status).toBe(400);
    // SAFETY: test asserts 400; response body shape is known
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("DOCX");
  });
});

// ── Handler: fill validation ─────────────────────────────

describe("fill handler validation", () => {
  test("rejects invalid JSON", async () => {
    const buf = await makeEmptyDocx();
    const file = await makeDocxFile(buf);
    const result = await fillHandler({
      scopedDb: stubScopedDb,
      organizationId: fakeOrgId,
      userId: fakeUserId,
      query: {},
      body: { file, values: "not json{" },
    });

    expect(result).toBeInstanceOf(Response);
    const resp = result;
    expect(resp.status).toBe(400);
    // SAFETY: test asserts 400; response body shape is known
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("Invalid JSON");
  });

  test("rejects array as values", async () => {
    const buf = await makeEmptyDocx();
    const file = await makeDocxFile(buf);
    const result = await fillHandler({
      scopedDb: stubScopedDb,
      organizationId: fakeOrgId,
      userId: fakeUserId,
      query: {},
      body: { file, values: "[1, 2, 3]" },
    });

    expect(result).toBeInstanceOf(Response);
    const resp = result;
    expect(resp.status).toBe(400);
    // SAFETY: test asserts 400; response body shape is known
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("object");
  });

  test("rejects null as values", async () => {
    const buf = await makeEmptyDocx();
    const file = await makeDocxFile(buf);
    const result = await fillHandler({
      scopedDb: stubScopedDb,
      organizationId: fakeOrgId,
      userId: fakeUserId,
      query: {},
      body: { file, values: "null" },
    });

    expect(result).toBeInstanceOf(Response);
    const resp = result;
    expect(resp.status).toBe(400);
    // SAFETY: test asserts 400; response body shape is known
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("object");
  });

  test("rejects object with null values", async () => {
    const buf = await makeEmptyDocx();
    const file = await makeDocxFile(buf);
    const result = await fillHandler({
      scopedDb: stubScopedDb,
      organizationId: fakeOrgId,
      userId: fakeUserId,
      query: {},
      body: { file, values: '{"name": null}' },
    });

    expect(result).toBeInstanceOf(Response);
    const resp = result;
    expect(resp.status).toBe(400);
    // SAFETY: test asserts 400; response body shape is known
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("null");
  });

  test("rejects nested null values", async () => {
    const buf = await makeEmptyDocx();
    const file = await makeDocxFile(buf);
    const result = await fillHandler({
      scopedDb: stubScopedDb,
      organizationId: fakeOrgId,
      userId: fakeUserId,
      query: {},
      body: {
        file,
        values: '{"person": {"name": null}}',
      },
    });

    expect(result).toBeInstanceOf(Response);
    const resp = result;
    expect(resp.status).toBe(400);
    // SAFETY: test asserts 400; response body shape is known
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("null");
  });
});

// ── Handler: fill diagnostic headers ─────────────────────

describe("fill handler diagnostic headers", () => {
  test("sets X-Unmatched-Placeholders header", async () => {
    const xml = WRAP([P("{{name}}"), P("{{city}}")].join(""));
    const buf = await makeDocx(xml);
    const file = await makeDocxFile(buf);

    const result = await fillHandler({
      scopedDb: stubScopedDb,
      organizationId: fakeOrgId,
      userId: fakeUserId,
      query: {},
      body: { file, values: JSON.stringify({ name: "Alice" }) },
    });

    expect(result).toBeInstanceOf(Response);
    const resp = result;
    expect(resp.status).toBe(200);
    const header = resp.headers.get("X-Unmatched-Placeholders");
    expect(header).toContain("city");
  });

  test("sets X-Unused-Values header", async () => {
    const xml = WRAP(P("{{name}}"));
    const buf = await makeDocx(xml);
    const file = await makeDocxFile(buf);

    const result = await fillHandler({
      scopedDb: stubScopedDb,
      organizationId: fakeOrgId,
      userId: fakeUserId,
      query: {},
      body: {
        file,
        values: JSON.stringify({ name: "Alice", extra: "unused" }),
      },
    });

    expect(result).toBeInstanceOf(Response);
    const resp = result;
    expect(resp.status).toBe(200);
    const header = resp.headers.get("X-Unused-Values");
    expect(header).toContain("extra");
  });

  test("omits diagnostic headers when everything matches", async () => {
    const xml = WRAP(P("{{name}}"));
    const buf = await makeDocx(xml);
    const file = await makeDocxFile(buf);

    const result = await fillHandler({
      scopedDb: stubScopedDb,
      organizationId: fakeOrgId,
      userId: fakeUserId,
      query: {},
      body: {
        file,
        values: JSON.stringify({ name: "Alice" }),
      },
    });

    expect(result).toBeInstanceOf(Response);
    const resp = result;
    expect(resp.status).toBe(200);
    expect(resp.headers.get("X-Unmatched-Placeholders")).toBeNull();
    expect(resp.headers.get("X-Unused-Values")).toBeNull();
    expect(resp.headers.get("X-Structure-Errors")).toBeNull();
  });
});

// ── Integration: discover → fill round-trip ──────────────

describe("discover → fill round-trip", () => {
  test("discover schema then fill with matching values", async () => {
    const xml = WRAP(
      [
        P("Client: {{client_name}}"),
        P("Date: {{effective_date}}"),
        P("Amount: {{amount}}"),
      ].join(""),
    );
    const buf = await makeDocx(xml);

    // Step 1: discover the schema
    const discovered = await discoverTemplate(buf);
    const manifest = await readManifest(buf);
    const fields = mergeManifestWithDiscovery(manifest, discovered);

    const fieldPaths = fields.map((f) => f.path).toSorted();
    expect(fieldPaths).toEqual(["amount", "client_name", "effective_date"]);

    // Step 2: build values from discovered fields
    const values: Record<string, string> = {};
    for (const field of fields) {
      values[field.path] = `value_for_${field.path}`;
    }

    // Step 3: fill the template
    const result = await fillTemplate(buf, values);

    expect(result.unmatchedPlaceholders).toEqual([]);
    expect(result.unusedValues).toEqual([]);

    const zip = await JSZip.loadAsync(result.buffer);
    const docXml = await zip.file("word/document.xml")?.async("string");
    expect(docXml).toContain("value_for_client_name");
    expect(docXml).toContain("value_for_effective_date");
    expect(docXml).toContain("value_for_amount");
  });

  test("discover enriched template then fill", async () => {
    const xml = WRAP(P("Client: {{clientName}}"));
    let buf = await makeDocx(xml);
    buf = await writeManifest(buf, sampleManifest);

    // Discover: should have manifest metadata
    const discovered = await discoverTemplate(buf);
    const manifest = await readManifest(buf);
    const fields = mergeManifestWithDiscovery(manifest, discovered);

    const clientField = fields.find((f) => f.path === "clientName");
    expect(clientField?.label).toBe("Client Name");
    expect(clientField?.required).toBe(true);

    // Fill: manifest is stripped from output
    const result = await fillTemplate(buf, {
      clientName: "Acme Corp",
    });

    const zip = await JSZip.loadAsync(result.buffer);
    const docXml = await zip.file("word/document.xml")?.async("string");
    expect(docXml).toContain("Acme Corp");

    // Verify manifest was stripped from filled document
    const outputManifest = await readManifest(result.buffer);
    expect(outputManifest).toBeNull();
  });
});
