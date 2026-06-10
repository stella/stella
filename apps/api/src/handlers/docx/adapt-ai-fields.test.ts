import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { adaptAiFields, type AiOccurrenceAdapter } from "./adapt-ai-fields";
import { fillTemplate } from "./patch-template";
import { readManifest, writeManifest } from "./template-manifest";
import type { FieldMeta } from "./types";

const makeDocx = async (documentXml: string): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>`,
  );
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

const documentText = async (buffer: Buffer): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const texts: string[] = [];
  for (const match of xml.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gu)) {
    if (match[1] !== undefined) {
      texts.push(match[1]);
    }
  }
  return texts.join("");
};

const lawField: FieldMeta = {
  path: "law",
  label: "Governing law",
  aiAdapt: true,
};

describe("adaptAiFields", () => {
  test("substitutes occurrence-by-occurrence, in document order", async () => {
    const docx = await makeDocx(
      WRAP(
        [
          P("This contract is governed by {{law}}."),
          P("Buyer: {{buyer}}"),
          P("Disputes under {{law}} go to the courts."),
        ].join(""),
      ),
    );

    const seen: { context: string }[][] = [];
    const adapter: AiOccurrenceAdapter = async ({ occurrences }) => {
      seen.push([...occurrences]);
      return occurrences.map((_, i) => `RENDERING-${String(i + 1)}`);
    };

    const adapted = await adaptAiFields({
      buffer: docx,
      fields: [lawField, { path: "buyer" }],
      values: { law: "czech law", buyer: "ACME" },
      adapt: adapter,
    });

    expect(adapted.adaptedPaths).toEqual(["law"]);
    // One adapter call for the field, one occurrence entry per marker, each
    // carrying the surrounding text with the marker left in place.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(2);
    expect(seen[0]?.[0]?.context).toContain(
      "This contract is governed by {{law}}.",
    );
    // ±400-char context crosses paragraph boundaries.
    expect(seen[0]?.[1]?.context).toContain("Buyer: {{buyer}}");
    expect(seen[0]?.[1]?.context).toContain(
      "Disputes under {{law}} go to the courts.",
    );

    const { buffer, unusedValues } = await fillTemplate(adapted.buffer, {
      law: "czech law",
      buyer: "ACME",
    });
    const text = await documentText(buffer);
    expect(text).toContain("governed by RENDERING-1.");
    expect(text).toContain("under RENDERING-2 go");
    expect(text).toContain("Buyer: ACME");
    expect(text).not.toContain("czech law");
    expect(
      unusedValues.filter((n) => !adapted.adaptedPaths.includes(n)),
    ).toEqual([]);
  });

  test("orders occurrences within a single paragraph", async () => {
    const docx = await makeDocx(WRAP(P("First {{law}}, then {{law}} again.")));
    const adapted = await adaptAiFields({
      buffer: docx,
      fields: [lawField],
      values: { law: "stub" },
      adapt: async () => ["ONE", "TWO"],
    });
    const text = await documentText(adapted.buffer);
    expect(text).toBe("First ONE, then TWO again.");
  });

  test("handles a marker split across runs", async () => {
    const docx = await makeDocx(
      WRAP(
        "<w:p><w:r><w:t>Per {{la</w:t></w:r><w:r><w:t>w}} of the land.</w:t></w:r></w:p>",
      ),
    );
    const adapted = await adaptAiFields({
      buffer: docx,
      fields: [lawField],
      values: { law: "stub" },
      adapt: async () => ["ADAPTED"],
    });
    const text = await documentText(adapted.buffer);
    expect(text).toBe("Per ADAPTED of the land.");
  });

  test("falls back to the stub on a rendering-count mismatch", async () => {
    const docx = await makeDocx(
      WRAP([P("A: {{law}}"), P("B: {{law}}")].join("")),
    );
    const adapted = await adaptAiFields({
      buffer: docx,
      fields: [lawField],
      values: { law: "czech law" },
      adapt: async () => ["only one"],
    });
    expect(adapted.adaptedPaths).toEqual([]);
    expect(adapted.buffer).toBe(docx);

    const { buffer } = await fillTemplate(adapted.buffer, {
      law: "czech law",
    });
    const text = await documentText(buffer);
    expect(text).toContain("A: czech law");
    expect(text).toContain("B: czech law");
  });

  test("reads a nested stub for a dotted field path", async () => {
    const docx = await makeDocx(WRAP(P("Company: {{company.name}}")));
    const adapted = await adaptAiFields({
      buffer: docx,
      fields: [{ path: "company.name", aiAdapt: true }],
      values: { company: { name: "ACME s.r.o." } },
      adapt: async ({ stub }) => [`ADAPTED(${stub})`],
    });
    const text = await documentText(adapted.buffer);
    expect(text).toBe("Company: ADAPTED(ACME s.r.o.)");
  });

  test("is a no-op without an adapter, aiAdapt fields, or a stub", async () => {
    const docx = await makeDocx(WRAP(P("{{law}}")));
    const noAdapter = await adaptAiFields({
      buffer: docx,
      fields: [lawField],
      values: { law: "stub" },
      adapt: undefined,
    });
    expect(noAdapter.buffer).toBe(docx);

    const noStub = await adaptAiFields({
      buffer: docx,
      fields: [lawField],
      values: {},
      adapt: async () => ["X"],
    });
    expect(noStub.buffer).toBe(docx);
    expect(noStub.adaptedPaths).toEqual([]);
  });
});

describe("manifest aiAdapt round-trip", () => {
  test("writeManifest/readManifest preserve the flag", async () => {
    const docx = await makeDocx(WRAP(P("{{law}} and {{buyer}}")));
    const withManifest = await writeManifest(docx, {
      version: 1,
      fields: [lawField, { path: "buyer" }],
    });
    const manifest = await readManifest(withManifest);
    expect(manifest?.fields).toEqual([
      { path: "law", label: "Governing law", aiAdapt: true },
      { path: "buyer" },
    ]);
  });
});
