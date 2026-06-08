import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { readManifest } from "@/api/handlers/docx/template-manifest";

import { prepareTemplateFromDocument } from "./prepare-template";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const makeDocx = async (paragraphs: string[]): Promise<Buffer> => {
  const para = (text: string) =>
    `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(para).join("")}<w:sectPr/></w:body></w:document>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", RELS);
  zip.file("word/document.xml", doc);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

describe("prepareTemplateFromDocument", () => {
  test("rewrites suggested literals as markers and embeds a manifest", async () => {
    const buffer = await makeDocx([
      "Granted by ROKA NIERUCHOMOŚCI Sp. z o.o.",
      "Scope: registration matters",
    ]);

    const {
      buffer: out,
      fields,
      unapplied,
    } = await prepareTemplateFromDocument({
      buffer,
      suggest: async () => [
        {
          literalText: "ROKA NIERUCHOMOŚCI Sp. z o.o.",
          fieldPath: "company.name",
        },
        {
          literalText: "registration matters",
          fieldPath: "scope",
          aiPrompt: "Draft the scope of this power of attorney",
        },
      ],
    });

    expect(unapplied).toEqual([]);
    expect(fields.map((f) => f.path)).toEqual(["company.name", "scope"]);
    expect(fields.find((f) => f.path === "scope")?.aiPrompt).toBe(
      "Draft the scope of this power of attorney",
    );

    const manifest = await readManifest(out);
    expect(manifest?.fields.map((f) => f.path)).toEqual([
      "company.name",
      "scope",
    ]);

    const zip = await JSZip.loadAsync(out);
    const docEntry = zip.file("word/document.xml");
    const xml = docEntry ? await docEntry.async("text") : "";
    expect(xml).toContain("{{company.name}}");
    expect(xml).toContain("{{scope}}");
    expect(xml).not.toContain("ROKA NIERUCHOMOŚCI");
  });

  test("returns the original document untouched when nothing is suggested", async () => {
    const buffer = await makeDocx(["A plain paragraph."]);
    const { fields, unapplied } = await prepareTemplateFromDocument({
      buffer,
      suggest: async () => [],
    });
    expect(fields).toEqual([]);
    expect(unapplied).toEqual([]);
  });
});
