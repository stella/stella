import { describe, expect, setDefaultTimeout, test } from "bun:test";
import JSZip from "jszip";
import * as slimdom from "slimdom";

import { fillTemplate } from "./patch-template";
import { writeManifest } from "./template-manifest";

// SPA fixture is ~177KB; template filling needs time.
setDefaultTimeout(15_000);

const SPA_FIXTURE = new URL(
  "fixtures/spa-template-with-placeholders.docx",
  import.meta.url,
).pathname;

describe("fillTemplate", () => {
  test("fills plain string values", async () => {
    const { buffer, unmatchedPlaceholders } = await fillTemplate(SPA_FIXTURE, {
      price_share_1: "1 250 000",
      price_share_2: "875 000",
      price_share_3: "2 100 000",
      price_share_4: "450 000",
      price_share_5: "3 750 000",
      contract_date: "15. ledna 2026",
      seller_1_name: "Novák Holdings s.r.o.",
      buyer_name: "Stella Legal a.s.",
    });

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file("word/document.xml")?.async("string");
    expect(docXml).toContain("1 250 000");
    expect(docXml).toContain("Stella Legal a.s.");
    expect(unmatchedPlaceholders).toEqual([]);
  });

  test("accepts a Buffer as template input", async () => {
    const file = Bun.file(SPA_FIXTURE);
    const templateBuffer = Buffer.from(await file.arrayBuffer());

    const { buffer } = await fillTemplate(templateBuffer, {
      price_share_1: "100",
      price_share_2: "200",
      price_share_3: "300",
      price_share_4: "400",
      price_share_5: "500",
      contract_date: "2026-01-01",
      seller_1_name: "Seller",
      buyer_name: "Buyer",
    });

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
  });

  test("reports unmatched placeholders", async () => {
    const { unmatchedPlaceholders } = await fillTemplate(SPA_FIXTURE, {
      price_share_1: "100",
    });

    expect(unmatchedPlaceholders.length).toBeGreaterThan(0);
    expect(unmatchedPlaceholders).toContain("buyer_name");
  });

  test("reports unused values", async () => {
    const { unusedValues } = await fillTemplate(SPA_FIXTURE, {
      price_share_1: "100",
      price_share_2: "200",
      price_share_3: "300",
      price_share_4: "400",
      price_share_5: "500",
      contract_date: "2026-01-01",
      seller_1_name: "Seller",
      buyer_name: "Buyer",
      nonexistent_field: "oops",
    });

    expect(unusedValues).toEqual(["nonexistent_field"]);
  });

  test("fills rich patch values with formatted runs", async () => {
    const { buffer } = await fillTemplate(SPA_FIXTURE, {
      price_share_1: "100",
      price_share_2: "200",
      price_share_3: "300",
      price_share_4: "400",
      price_share_5: "500",
      contract_date: "2026-01-01",
      seller_1_name: {
        paragraphs: [
          {
            runs: [{ text: "Novák ", bold: true }, { text: "Holdings s.r.o." }],
          },
        ],
      },
      buyer_name: "Stella Legal a.s.",
    });

    expect(buffer).toBeInstanceOf(Buffer);
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file("word/document.xml")?.async("string");
    // Bold run should produce <w:b/> in run properties
    expect(docXml).toContain("Novák ");
    expect(docXml).toContain("Holdings s.r.o.");
  });
});

// ── Block directive e2e tests ────────────────────────────

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

const extractTexts = async (buffer: Buffer): Promise<string[]> => {
  const zip = await JSZip.loadAsync(buffer);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  // Simple extraction: find all w:t content
  const texts: string[] = [];
  for (const match of xml.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gu)) {
    if (match[1] !== undefined) {
      texts.push(match[1]);
    }
  }
  return texts;
};

describe("fillTemplate — block directives e2e", () => {
  test("conditional + value substitution", async () => {
    const xml = WRAP(
      [
        P("Contract for {{buyer_name}}"),
        P("{{#if has_guarantor}}"),
        P("Guarantor: {{guarantor_name}}"),
        P("{{/if}}"),
        P("End of contract"),
      ].join(""),
    );
    const docx = await makeDocx(xml);

    const { buffer } = await fillTemplate(docx, {
      buyer_name: "Stella Legal",
      has_guarantor: true,
      guarantor_name: "Jan Novák",
    });

    const texts = await extractTexts(buffer);
    const joined = texts.join(" ");
    expect(joined).toContain("Stella Legal");
    expect(joined).toContain("Jan Novák");
    expect(joined).toContain("End of contract");
    // Directive paragraphs should be gone
    expect(joined).not.toContain("{{#if");
    expect(joined).not.toContain("{{/if");
  });

  test("conditional false removes content", async () => {
    const xml = WRAP(
      [
        P("Before"),
        P("{{#if has_guarantor}}"),
        P("Guarantor: {{guarantor_name}}"),
        P("{{/if}}"),
        P("After"),
      ].join(""),
    );
    const docx = await makeDocx(xml);

    const { buffer } = await fillTemplate(docx, {
      has_guarantor: false,
      guarantor_name: "Should not appear",
    });

    const texts = await extractTexts(buffer);
    const joined = texts.join(" ");
    expect(joined).toContain("Before");
    expect(joined).toContain("After");
    expect(joined).not.toContain("Guarantor");
    expect(joined).not.toContain("Should not appear");
  });

  test("loop + value substitution", async () => {
    const xml = WRAP(
      [
        P("Sellers:"),
        P("{{#each sellers}}"),
        P("Name: {{sellers.name}}, ID: {{sellers.id}}"),
        P("{{/each}}"),
        P("End"),
      ].join(""),
    );
    const docx = await makeDocx(xml);

    const { buffer } = await fillTemplate(docx, {
      sellers: [
        { name: "Alice", id: "A1" },
        { name: "Bob", id: "B2" },
      ],
    });

    const texts = await extractTexts(buffer);
    const joined = texts.join(" ");
    expect(joined).toContain("Alice");
    expect(joined).toContain("A1");
    expect(joined).toContain("Bob");
    expect(joined).toContain("B2");
    expect(joined).toContain("End");
    expect(joined).not.toContain("{{#each");
  });

  test("nested objects with dotted paths", async () => {
    const xml = WRAP(
      [
        P("Company: {{company.name}}"),
        P("Reg: {{company.registration_number}}"),
      ].join(""),
    );
    const docx = await makeDocx(xml);

    const { buffer } = await fillTemplate(docx, {
      company: {
        name: "Acme Corp",
        registration_number: "CZ12345",
      },
    });

    const texts = await extractTexts(buffer);
    const joined = texts.join(" ");
    expect(joined).toContain("Acme Corp");
    expect(joined).toContain("CZ12345");
  });

  test("backward compatibility: plain PatchValues", async () => {
    const xml = WRAP(P("Hello {{name}}"));
    const docx = await makeDocx(xml);

    const { buffer } = await fillTemplate(docx, {
      name: "World",
    });

    const texts = await extractTexts(buffer);
    expect(texts.join(" ")).toContain("World");
  });

  test("template without directives skips pre-processing", async () => {
    const xml = WRAP([P("{{x}}"), P("{{y}}")].join(""));
    const docx = await makeDocx(xml);

    const { buffer, unmatchedPlaceholders, unusedValues } = await fillTemplate(
      docx,
      {
        x: "hello",
        y: "world",
      },
    );

    expect(buffer).toBeInstanceOf(Buffer);
    expect(unmatchedPlaceholders).toEqual([]);
    expect(unusedValues).toEqual([]);
  });
});

// ── Structural invariant: filled output stays well-formed ─

/**
 * Representative template exercising every DOM-mutating fill stage at once:
 * a two-column table with markers split across runs, an inline {{#if}} span
 * whose markers straddle run boundaries, an {{#each}} loop over numbered
 * list paragraphs (one valid numId, one dangling), and a whole-paragraph
 * {{#if}} block. The assertion is the invariant that matters for Word
 * compatibility, not an example: every XML part of the output must parse as
 * well-formed XML and no part may disappear from the package.
 */
const SPLIT = (...chunks: string[]) =>
  `<w:p>${chunks.map((chunk) => `<w:r><w:t xml:space="preserve">${chunk}</w:t></w:r>`).join("")}</w:p>`;

const NUMBERED = (numId: number, text: string) =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>` +
  `<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const NUMBERING_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
  `</w:numbering>`;

const makeStructuralFixture = async (): Promise<Buffer> => {
  const cell = (content: string) => `<w:tc><w:tcPr/>${content}</w:tc>`;
  const table = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid><w:tr>${cell(
    SPLIT("Pełnomocnik: {", "{agent_", "name}} (PL)"),
  )}${cell(SPLIT("Attorney: {{agent", "_name}", "} (EN)"))}</w:tr></w:tbl>`;

  const xml = WRAP(
    [
      SPLIT(
        "The Buyer{{#if has",
        "Spouse}} and their spouse{",
        "{/if}} agrees.",
      ),
      table,
      P("{{#if showClause}}"),
      P("Optional clause for {{client}}"),
      P("{{/if}}"),
      P("{{#each items}}"),
      NUMBERED(1, "Item {{items.label}} (kept numbering)"),
      NUMBERED(99, "Item {{items.label}} (dangling numbering)"),
      P("{{/each}}"),
      P("Done."),
    ].join(""),
  );

  const zip = new JSZip();
  zip.file("word/document.xml", xml);
  zip.file("word/numbering.xml", NUMBERING_XML);
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

describe("fillTemplate — output stays well-formed in every part", () => {
  test("table + inline if + loop numbering + split-run markers", async () => {
    const fixture = await makeStructuralFixture();

    const { buffer, structureErrors, unmatchedPlaceholders } =
      await fillTemplate(fixture, {
        agent_name: "Maciej Kuropatwiński",
        hasSpouse: true,
        showClause: true,
        client: "rč & co.",
        items: [{ label: "first" }, { label: "second" }],
      });

    expect(structureErrors).toEqual([]);
    expect(unmatchedPlaceholders).toEqual([]);

    const inZip = await JSZip.loadAsync(fixture);
    const outZip = await JSZip.loadAsync(buffer);
    const partNames = (zip: JSZip) =>
      Object.keys(zip.files)
        .filter((name) => !zip.files[name]?.dir)
        .toSorted();
    // Package integrity: no part may be lost or invented by the fill.
    expect(partNames(outZip)).toEqual(partNames(inZip));

    for (const name of partNames(outZip)) {
      const xml = await outZip.files[name]?.async("string");
      if (xml === undefined) {
        throw new Error(`part ${name} unreadable`);
      }
      // Well-formedness of every part — parseXmlDocument throws otherwise.
      expect(() => slimdom.parseXmlDocument(xml)).not.toThrow();
    }

    const texts = (await extractTexts(buffer)).join(" ");
    expect(texts).toContain("and their spouse");
    expect(texts).toContain("Maciej Kuropatwiński");
    expect(texts).toContain("first");
    expect(texts).toContain("second");
    expect(texts).not.toContain("{{");
  });
});

// ── Boolean condition-field as a {{#if}} target ──────────

describe("fillTemplate — {{#if field_path}} resolves a condition-field rule", () => {
  const makeConditionDocx = async (): Promise<Buffer> => {
    const xml = WRAP(
      [
        P("Before"),
        P("{{#if is_company}}"),
        P("Company clause for {{client.name}}"),
        P("{{/if}}"),
        P("After"),
      ].join(""),
    );
    const docx = await makeDocx(xml);
    // The condition-field carries no marker; its rule is evaluated by name.
    return await writeManifest(docx, {
      version: 1,
      fields: [
        {
          path: "is_company",
          inputType: "boolean",
          condition: 'client.type == "company"',
        },
      ],
    });
  };

  test("includes the block when the field's rule is true", async () => {
    const { buffer } = await fillTemplate(await makeConditionDocx(), {
      client: { type: "company", name: "ACME" },
    });
    const joined = (await extractTexts(buffer)).join(" ");
    expect(joined).toContain("Company clause for");
    expect(joined).toContain("ACME");
    expect(joined).toContain("After");
    expect(joined).not.toContain("{{#if");
  });

  test("excludes the block when the field's rule is false", async () => {
    const { buffer } = await fillTemplate(await makeConditionDocx(), {
      client: { type: "individual", name: "Jan Novák" },
    });
    const joined = (await extractTexts(buffer)).join(" ");
    expect(joined).toContain("Before");
    expect(joined).toContain("After");
    expect(joined).not.toContain("Company clause");
  });
});
