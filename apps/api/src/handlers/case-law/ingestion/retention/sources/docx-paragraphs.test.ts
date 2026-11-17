import { expect, test } from "bun:test";

import { ZipArchive } from "@stll/docx-core/zip";

import { docxParagraphs } from "@/api/handlers/case-law/ingestion/retention/sources/docx-paragraphs";

const xml = (padding: number) =>
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Rozhodnutí soudu</w:t></w:r></w:p>${" ".repeat(padding)}</w:body></w:document>`;

test.each(["store", "deflate"] as const)(
  "reads paragraphs within the %s package budget",
  async (compression) => {
    const zip = new ZipArchive();
    zip.set("word/document.xml", xml(0));
    const bytes = await zip.generate({ compression });
    expect(await docxParagraphs(bytes)).toEqual(["Rozhodnutí soudu"]);
  },
);

test.each([
  { compression: "deflate", parts: 1, padding: 8 * 1024 * 1024 },
  { compression: "store", parts: 1, padding: 8 * 1024 * 1024 },
  { compression: "deflate", parts: 3, padding: 6 * 1024 * 1024 },
] as const)(
  "refuses package output beyond its entry or aggregate budget: %j",
  async ({ compression, parts, padding }) => {
    const zip = new ZipArchive();
    const names = [
      "word/document.xml",
      "word/footnotes.xml",
      "word/endnotes.xml",
    ];
    for (const name of names.slice(0, parts)) {
      zip.set(name, xml(padding));
    }
    const bytes = await zip.generate({ compression });
    if (compression === "deflate") {
      expect(bytes.byteLength).toBeLessThan(padding / 100);
    }
    expect(await docxParagraphs(bytes)).toBeNull();
  },
);
