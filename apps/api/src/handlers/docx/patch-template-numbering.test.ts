import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { fillTemplate } from "./patch-template";

type TestParagraph = string | { text: string; numId: number };

type BuildDocxOptions = { numberingXml?: string };

const buildDocxBuffer = async (
  paragraphs: TestParagraph[],
  options?: BuildDocxOptions,
): Promise<Buffer> => {
  const para = (p: TestParagraph) => {
    const { text, numId } =
      typeof p === "string" ? { text: p, numId: undefined } : p;
    const pPr =
      numId === undefined
        ? ""
        : `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>`;
    return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  };
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(para).join("")}<w:sectPr/></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rels);
  zip.file("word/document.xml", documentXml);
  if (options?.numberingXml !== undefined) {
    zip.file("word/numbering.xml", options.numberingXml);
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

// Concatenated visible text: value substitution splits a paragraph into
// multiple <w:t> runs, so assert on the stripped text, not the raw XML.
const docTextOf = async (buffer: Buffer): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer);
  let text = (await zip.file("word/document.xml")?.async("string")) ?? "";
  // Strip tags until stable so a tag span revealed by an earlier removal can't
  // survive — the single-pass form trips CodeQL's incomplete-sanitization check.
  let previous = "";
  while (text !== previous) {
    previous = text;
    // oxlint-disable-next-line sonarjs/slow-regex -- test helper on small, controlled document XML
    text = text.replace(/<[^>]+>/gu, "");
  }
  return text;
};

const lease = [
  "Clause {{@num:rent}}. Rent is {{rent}}.",
  "{{#if has_guarantee}}",
  "Clause {{@num:guarantee}}. Guarantee provided.",
  "{{/if}}",
  "See Clause {{@ref:rent}}. Per Clause {{@ref:guarantee}}.",
];

describe("fillTemplate — cross-reference numbering", () => {
  test("numbers included clauses and resolves references to them", async () => {
    const docx = await buildDocxBuffer(lease);
    const { buffer } = await fillTemplate(docx, {
      rent: "5000",
      has_guarantee: true,
    });
    const text = await docTextOf(buffer);

    expect(text).toContain("Clause 1. Rent is 5000.");
    expect(text).toContain("Clause 2. Guarantee provided.");
    // forward + backward refs resolve to the assigned numbers
    expect(text).toContain("See Clause 1. Per Clause 2.");
  });

  test("a clause excluded by a condition is not numbered; its ref stays unresolved", async () => {
    const docx = await buildDocxBuffer(lease);
    const { buffer } = await fillTemplate(docx, {
      rent: "5000",
      has_guarantee: false,
    });
    const text = await docTextOf(buffer);

    expect(text).toContain("Clause 1. Rent is 5000.");
    expect(text).not.toContain("Guarantee provided.");
    // rent is still clause 1; the dropped guarantee reference is left visible
    expect(text).toContain("See Clause 1.");
    expect(text).toContain("{{@ref:guarantee}}");
  });
});

describe("fillTemplate — @num/@ref through {{#each}} expansion", () => {
  test("each iteration is numbered sequentially; refs resolve per iteration", async () => {
    const docx = await buildDocxBuffer([
      "Clause {{@num:intro}}. Introduction.",
      "{{#each parties}}",
      "Clause {{@num:party}}. {{parties.name}} is a party (see Clause {{@ref:party}}, cf. Clause {{@ref:intro}}).",
      "{{/each}}",
      "Closing per Clause {{@ref:intro}}.",
    ]);
    const { buffer } = await fillTemplate(docx, {
      parties: [{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }],
    });
    const text = await docTextOf(buffer);

    expect(text).toContain("Clause 1. Introduction.");
    expect(text).toContain(
      "Clause 2. Alpha is a party (see Clause 2, cf. Clause 1).",
    );
    expect(text).toContain(
      "Clause 3. Beta is a party (see Clause 3, cf. Clause 1).",
    );
    expect(text).toContain(
      "Clause 4. Gamma is a party (see Clause 4, cf. Clause 1).",
    );
    expect(text).toContain("Closing per Clause 1.");
  });

  test("a ref from outside the loop to a loop-local key stays unresolved", async () => {
    const docx = await buildDocxBuffer([
      "{{#each items}}",
      "Clause {{@num:item}}. {{items.name}}.",
      "{{/each}}",
      "See Clause {{@ref:item}}.",
    ]);
    const { buffer } = await fillTemplate(docx, {
      items: [{ name: "A" }, { name: "B" }],
    });
    const text = await docTextOf(buffer);

    expect(text).toContain("Clause 1. A.");
    expect(text).toContain("Clause 2. B.");
    // Ambiguous target (one per iteration) — left visible as a diagnostic
    expect(text).toContain("See Clause {{@ref:item}}.");
  });

  test("iterations excluded by a nested {{#if}} do not consume numbers", async () => {
    const docx = await buildDocxBuffer([
      "{{#each items}}",
      "{{#if items.include}}",
      "Clause {{@num:item}}. {{items.name}}.",
      "{{/if}}",
      "{{/each}}",
    ]);
    const { buffer } = await fillTemplate(docx, {
      items: [
        { name: "A", include: true },
        { name: "B", include: false },
        { name: "C", include: true },
      ],
    });
    const text = await docTextOf(buffer);

    expect(text).toContain("Clause 1. A.");
    expect(text).toContain("Clause 2. C.");
    expect(text).not.toContain("B.");
  });

  test("nested loops number every inner occurrence sequentially", async () => {
    const docx = await buildDocxBuffer([
      "{{#each groups}}",
      "{{#each subitems}}",
      "Item {{@num:sub}}.",
      "{{/each}}",
      "{{/each}}",
    ]);
    const { buffer } = await fillTemplate(docx, {
      groups: [{ subitems: ["a", "b"] }, { subitems: ["c"] }],
    });
    const text = await docTextOf(buffer);

    expect(text).toContain("Item 1.");
    expect(text).toContain("Item 2.");
    expect(text).toContain("Item 3.");
    expect(text).not.toContain("Item 4.");
  });
});

describe("fillTemplate — {{@index}}/{{@count}} through {{#each}} expansion", () => {
  test("block loop resolves index/count and composes with item fields", async () => {
    const docx = await buildDocxBuffer([
      "{{#each parties}}",
      "{{@index}}/{{@count}}: {{parties.name}}.",
      "{{/each}}",
    ]);
    const { buffer } = await fillTemplate(docx, {
      parties: [{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }],
    });
    const text = await docTextOf(buffer);

    expect(text).toContain("1/3: Alpha.");
    expect(text).toContain("2/3: Beta.");
    expect(text).toContain("3/3: Gamma.");
  });

  test("nested loops bind @index/@count to the innermost loop", async () => {
    const docx = await buildDocxBuffer([
      "{{#each groups}}",
      "G{{@index}}/{{@count}}.",
      "{{#each groups.items}}",
      "I{{@index}}/{{@count}}.",
      "{{/each}}",
      "{{/each}}",
    ]);
    const { buffer } = await fillTemplate(docx, {
      groups: [{ items: ["a", "b"] }, { items: ["c"] }],
    });
    const text = await docTextOf(buffer);

    expect(text).toContain("G1/2.");
    expect(text).toContain("G2/2.");
    // First group: two inner items numbered 1/2, 2/2; second group: 1/1.
    expect(text).toContain("I1/2.I2/2.");
    expect(text).toContain("I1/1.");
  });
});

// numId 1 resolves (num → abstractNum); numId 2 dangles on a missing abstractNum.
const NUMBERING_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
  `<w:num w:numId="2"><w:abstractNumId w:val="99"/></w:num>` +
  `</w:numbering>`;

const numIdsOf = async (buffer: Buffer): Promise<string[]> => {
  const zip = await JSZip.loadAsync(buffer);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  return [...xml.matchAll(/<w:numId w:val="(\d+)"\s*\/?>/gu)].flatMap((m) =>
    m[1] ? [m[1]] : [],
  );
};

describe("fillTemplate — w:numPr through {{#each}} expansion", () => {
  test("cloned list paragraphs keep the template numId (one continuous Word sequence) and numbering.xml is untouched", async () => {
    const docx = await buildDocxBuffer(
      ["{{#each items}}", { text: "{{items.name}}", numId: 1 }, "{{/each}}"],
      { numberingXml: NUMBERING_XML },
    );
    const { buffer } = await fillTemplate(docx, {
      items: [{ name: "A" }, { name: "B" }, { name: "C" }],
    });

    // All iterations reference the same numbering instance: Word
    // counters live on the (shared) definition, so the rendered list
    // continues 1..3 instead of restarting per iteration.
    expect(await numIdsOf(buffer)).toEqual(["1", "1", "1"]);

    const zip = await JSZip.loadAsync(buffer);
    expect(await zip.file("word/numbering.xml")?.async("string")).toBe(
      NUMBERING_XML,
    );
  });

  test("a cloned numPr whose numId does not resolve is pruned", async () => {
    const docx = await buildDocxBuffer(
      [
        "{{#each items}}",
        { text: "{{items.name}}", numId: 2 },
        "{{/each}}",
        { text: "Outside loop", numId: 7 },
      ],
      { numberingXml: NUMBERING_XML },
    );
    const { buffer } = await fillTemplate(docx, {
      items: [{ name: "A" }, { name: "B" }],
    });

    expect(await numIdsOf(buffer)).toEqual([]);
    const text = await docTextOf(buffer);
    expect(text).toContain("A");
    expect(text).toContain("B");
  });

  test("without word/numbering.xml every numPr is pruned from the expanded document", async () => {
    const docx = await buildDocxBuffer([
      "{{#each items}}",
      { text: "{{items.name}}", numId: 1 },
      "{{/each}}",
    ]);
    const { buffer } = await fillTemplate(docx, {
      items: [{ name: "A" }],
    });

    expect(await numIdsOf(buffer)).toEqual([]);
  });
});
