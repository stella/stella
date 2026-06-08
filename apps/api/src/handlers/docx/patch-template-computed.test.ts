import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { fillTemplate } from "./patch-template";
import { writeManifest } from "./template-manifest";
import type { TemplateManifest } from "./types";

const buildDocxBuffer = async (paragraphs: string[]): Promise<Buffer> => {
  const para = (text: string) =>
    `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(para).join("")}<w:sectPr/></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rels);
  zip.file("word/document.xml", documentXml);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

const docXmlOf = async (buffer: Buffer): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer);
  return (await zip.file("word/document.xml")?.async("string")) ?? "";
};

describe("fillTemplate — computed fields", () => {
  test("evaluates a manifest computed field and substitutes it", async () => {
    const docx = await buildDocxBuffer([
      "Annual rent: {{annual_rent}}",
      "Monthly rent: {{rent}}",
    ]);
    const manifest: TemplateManifest = {
      version: 1,
      fields: [{ path: "rent" }],
      conditions: [],
      computed: [{ name: "annual_rent", expression: "rent * 12" }],
    };
    const withManifest = await writeManifest(docx, manifest);

    const { buffer, unmatchedPlaceholders } = await fillTemplate(withManifest, {
      rent: "1000",
    });

    expect(await docXmlOf(buffer)).toContain("12000");
    expect(unmatchedPlaceholders).toEqual([]);
  });

  test("indexation cap: indexed rent capped at +5%/yr (Maciej's lease)", async () => {
    const docx = await buildDocxBuffer(["New rent: {{rent_indexed}}"]);
    const manifest: TemplateManifest = {
      version: 1,
      fields: [{ path: "rent" }, { path: "index" }],
      conditions: [],
      computed: [
        {
          name: "rent_indexed",
          expression: "min(rent * (1 + index / 100), rent * 1.05)",
        },
      ],
    };
    const withManifest = await writeManifest(docx, manifest);

    const { buffer } = await fillTemplate(withManifest, {
      rent: "10000",
      index: "7", // 7% index, but the 5% cap wins
    });

    expect(await docXmlOf(buffer)).toContain("10500");
  });

  test("a value the user entered overrides the computed default", async () => {
    const docx = await buildDocxBuffer(["Total: {{total}}"]);
    const manifest: TemplateManifest = {
      version: 1,
      fields: [{ path: "total" }],
      conditions: [],
      computed: [{ name: "total", expression: "rent * 12" }],
    };
    const withManifest = await writeManifest(docx, manifest);

    const { buffer } = await fillTemplate(withManifest, {
      rent: "1000",
      total: "99999",
    });

    expect(await docXmlOf(buffer)).toContain("99999");
  });
});
