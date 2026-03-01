import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { discoverPlaceholders } from "./discover-placeholders";

const SPA_FIXTURE = new URL(
  "./fixtures/spa-template-with-placeholders.docx",
  import.meta.url,
).pathname;

/** Build a minimal DOCX buffer with the given document.xml. */
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

describe("discoverPlaceholders", () => {
  test("finds placeholders in a single run", async () => {
    const xml = WRAP(
      "<w:p><w:r><w:t>Hello {{name}}, welcome.</w:t></w:r></w:p>",
    );
    const buf = await makeDocx(xml);
    const result = await discoverPlaceholders(buf);

    expect(result).toEqual([{ name: "name", count: 1 }]);
  });

  test("finds placeholders split across runs", async () => {
    const xml = WRAP(
      `<w:p>
        <w:r><w:t>Price: {{</w:t></w:r>
        <w:r><w:t>amount</w:t></w:r>
        <w:r><w:t>}} EUR</w:t></w:r>
      </w:p>`,
    );
    const buf = await makeDocx(xml);
    const result = await discoverPlaceholders(buf);

    expect(result).toEqual([{ name: "amount", count: 1 }]);
  });

  test("counts multiple occurrences", async () => {
    const xml = WRAP(
      `<w:p><w:r><w:t>{{x}} and {{x}}</w:t></w:r></w:p>
       <w:p><w:r><w:t>also {{x}}</w:t></w:r></w:p>`,
    );
    const buf = await makeDocx(xml);
    const result = await discoverPlaceholders(buf);

    expect(result).toEqual([{ name: "x", count: 3 }]);
  });

  test("returns empty for no placeholders", async () => {
    const xml = WRAP("<w:p><w:r><w:t>No tags here.</w:t></w:r></w:p>");
    const buf = await makeDocx(xml);
    const result = await discoverPlaceholders(buf);

    expect(result).toEqual([]);
  });

  test("results are sorted alphabetically", async () => {
    const xml = WRAP(
      "<w:p><w:r><w:t>{{zebra}} {{alpha}} {{mid}}</w:t></w:r></w:p>",
    );
    const buf = await makeDocx(xml);
    const result = await discoverPlaceholders(buf);

    expect(result.map((p) => p.name)).toEqual(["alpha", "mid", "zebra"]);
  });

  test("works on the SPA fixture", async () => {
    const file = Bun.file(SPA_FIXTURE);
    const buf = Buffer.from(await file.arrayBuffer());
    const result = await discoverPlaceholders(buf);

    const names = result.map((p) => p.name);
    expect(names).toContain("price_share_1");
    expect(names).toContain("contract_date");
    expect(names).toContain("buyer_name");
    expect(names).toContain("seller_1_name");
    expect(result.length).toBeGreaterThanOrEqual(8);
  });
});
