import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import * as slimdom from "slimdom";

import { processBlockDirectives } from "./block-directives";
import { paragraphText, W_NS } from "./ooxml";
import { fillTemplate } from "./patch-template";

// ── Fixture builders ─────────────────────────────────────

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const TC = (...paragraphs: string[]) => `<w:tc>${paragraphs.join("")}</w:tc>`;
const TR = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;
const TBL = (...rows: string[]) => `<w:tbl>${rows.join("")}</w:tbl>`;

const parseBody = (xml: string): slimdom.Element => {
  const doc = slimdom.parseXmlDocument(xml);
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) {
    throw new Error("No w:body element found");
  }
  return body;
};

const bodyTexts = (body: slimdom.Element): string[] =>
  [...body.getElementsByTagNameNS(W_NS, "p")].map((p) => paragraphText(p));

const rowCount = (body: slimdom.Element): number =>
  body.getElementsByTagNameNS(W_NS, "tr").length;

const tableCount = (body: slimdom.Element): number =>
  body.getElementsByTagNameNS(W_NS, "tbl").length;

// A minimal DOCX ZIP for end-to-end fillTemplate coverage.
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

const documentText = async (buffer: Buffer): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const texts: string[] = [];
  // Match the text element `<w:t>` / `<w:t ...>` only — not `<w:tr>`/`<w:tc>`.
  for (const match of xml.matchAll(/<w:t(?:\s[^>]*)?>(?<text>.*?)<\/w:t>/gu)) {
    if (match[1] !== undefined) {
      texts.push(match[1]);
    }
  }
  return texts.join("");
};

// ── Row repeat ───────────────────────────────────────────

describe("processBlockDirectives — table-row repeat", () => {
  test("clones the w:tr per item and rewrites item placeholders", () => {
    const xml = WRAP(
      TBL(
        TR(TC(P("Field")), TC(P("Value"))),
        TR(
          TC(P("{{#each fields}}"), P("{{fields.label}}")),
          TC(P("{{fields.value}}"), P("{{/each}}")),
        ),
      ),
    );
    const body = parseBody(xml);
    const { patchValues, errors } = processBlockDirectives(body, {
      fields: [
        { label: "Term", value: "2y" },
        { label: "Law", value: "CZ" },
      ],
    });

    expect(errors).toEqual([]);
    // header row + one cloned row per item
    expect(rowCount(body)).toBe(3);

    const texts = bodyTexts(body);
    expect(texts).toContain("{{__each_fields_0_label}}");
    expect(texts).toContain("{{__each_fields_0_value}}");
    expect(texts).toContain("{{__each_fields_1_label}}");
    expect(texts).toContain("{{__each_fields_1_value}}");
    // marker text is stripped from the output rows
    expect(texts).not.toContain("{{#each fields}}");
    expect(texts).not.toContain("{{/each}}");

    expect(patchValues["__each_fields_0_label"]).toBe("Term");
    expect(patchValues["__each_fields_0_value"]).toBe("2y");
    expect(patchValues["__each_fields_1_label"]).toBe("Law");
    expect(patchValues["__each_fields_1_value"]).toBe("CZ");
  });

  test("markers wrapping content in a single cell strip cleanly", () => {
    const xml = WRAP(
      TBL(
        TR(
          TC(
            P("{{#each rows}}"),
            P("{{rows.label}}: {{rows.value}}"),
            P("{{/each}}"),
          ),
        ),
      ),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, {
      rows: [{ label: "A", value: "1" }],
    });

    expect(rowCount(body)).toBe(1);
    expect(bodyTexts(body)).toEqual([
      "{{__each_rows_0_label}}: {{__each_rows_0_value}}",
    ]);
  });

  test("zero items removes the template row", () => {
    const xml = WRAP(
      TBL(
        TR(TC(P("Field")), TC(P("Value"))),
        TR(
          TC(P("{{#each fields}}"), P("{{fields.label}}")),
          TC(P("{{fields.value}}"), P("{{/each}}")),
        ),
      ),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, { fields: [] });

    expect(errors).toEqual([]);
    expect(rowCount(body)).toBe(1);
    expect(bodyTexts(body)).toEqual(["Field", "Value"]);
  });

  test("{{@index}} / {{@count}} resolve inside cloned rows", () => {
    const xml = WRAP(
      TBL(
        TR(TC(P("{{#each rows}}"), P("{{@index}}/{{@count}}"), P("{{/each}}"))),
      ),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, { rows: [{}, {}, {}] });

    expect(rowCount(body)).toBe(3);
    expect(bodyTexts(body)).toEqual(["1/3", "2/3", "3/3"]);
  });
});

// ── Ambiguous placements ─────────────────────────────────

describe("processBlockDirectives — malformed table placement", () => {
  test("opener inside a row, closer outside the table → structure error", () => {
    const xml = WRAP(
      TBL(TR(TC(P("{{#each x}}")))) + P("{{x.v}}") + P("{{/each}}"),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, {
      x: [{ v: "a" }],
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toContain("table");
    // markers neutralized: no {{#each}} / {{/each}} left to loop on
    expect(bodyTexts(body)).not.toContain("{{#each x}}");
    expect(bodyTexts(body)).not.toContain("{{/each}}");
  });

  test("opener and closer in different rows → structure error", () => {
    const xml = WRAP(TBL(TR(TC(P("{{#each x}}"))), TR(TC(P("{{/each}}")))));
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, {
      x: [{ v: "a" }],
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toContain("table");
  });
});

// ── Table cloning in body-level loops ────────────────────

describe("processBlockDirectives — table cloning in body loops", () => {
  test("a whole table between body-level markers is cloned per item", () => {
    const xml = WRAP(
      P("{{#each sections}}") +
        P("Section: {{sections.title}}") +
        TBL(TR(TC(P("Detail: {{sections.detail}}")))) +
        P("{{/each}}"),
    );
    const body = parseBody(xml);
    const { patchValues, errors } = processBlockDirectives(body, {
      sections: [
        { title: "A", detail: "d1" },
        { title: "B", detail: "d2" },
      ],
    });

    expect(errors).toEqual([]);
    // one cloned table per item
    expect(tableCount(body)).toBe(2);

    const texts = bodyTexts(body);
    expect(texts).toEqual([
      "Section: {{__each_sections_0_title}}",
      "Detail: {{__each_sections_0_detail}}",
      "Section: {{__each_sections_1_title}}",
      "Detail: {{__each_sections_1_detail}}",
    ]);
    expect(patchValues["__each_sections_0_title"]).toBe("A");
    expect(patchValues["__each_sections_1_detail"]).toBe("d2");
  });
});

// ── Nested: contracts → fields (DD acceptance shape) ─────

describe("processBlockDirectives — nested each (contracts → fields)", () => {
  test("outer body loop with an inner row-repeat resolves both levels", () => {
    const xml = WRAP(
      P("{{#each contracts}}") +
        P("Contract: {{contracts.name}}") +
        TBL(
          TR(TC(P("Field")), TC(P("Value"))),
          TR(
            TC(
              P("{{#each contracts.fields}}"),
              P("{{contracts.fields.label}}"),
            ),
            TC(P("{{contracts.fields.value}}"), P("{{/each}}")),
          ),
        ) +
        P("{{/each}}"),
    );
    const body = parseBody(xml);
    const { patchValues, errors } = processBlockDirectives(body, {
      contracts: [
        {
          name: "NDA",
          fields: [
            { label: "Term", value: "2y" },
            { label: "Law", value: "CZ" },
          ],
        },
        { name: "MSA", fields: [{ label: "Fee", value: "1000" }] },
      ],
    });

    expect(errors).toEqual([]);
    // one table per contract
    expect(tableCount(body)).toBe(2);
    // NDA: header + 2 field rows; MSA: header + 1 field row
    expect(rowCount(body)).toBe(5);

    expect(patchValues["__each_contracts_0_name"]).toBe("NDA");
    expect(patchValues["__each_contracts_1_name"]).toBe("MSA");
    // Inner keys are namespaced by the outer per-item key, so field rows never
    // collide across contracts.
    expect(patchValues["__each___each_contracts_0_fields_0_label"]).toBe(
      "Term",
    );
    expect(patchValues["__each___each_contracts_0_fields_1_value"]).toBe("CZ");
    expect(patchValues["__each___each_contracts_1_fields_0_label"]).toBe("Fee");
  });
});

// ── End-to-end through fillTemplate ──────────────────────

describe("fillTemplate — tables", () => {
  test("standalone row-repeat produces a valid filled DOCX", async () => {
    const docx = await makeDocx(
      WRAP(
        TBL(
          TR(TC(P("Field")), TC(P("Value"))),
          TR(
            TC(P("{{#each fields}}"), P("{{fields.label}}")),
            TC(P("{{fields.value}}"), P("{{/each}}")),
          ),
        ),
      ),
    );
    const { buffer, unmatchedPlaceholders, structureErrors } =
      await fillTemplate(docx, {
        fields: [
          { label: "Term", value: "2y" },
          { label: "Law", value: "CZ" },
        ],
      });

    expect(structureErrors).toEqual([]);
    expect(unmatchedPlaceholders).toEqual([]);
    const text = await documentText(buffer);
    expect(text).toContain("Term");
    expect(text).toContain("2y");
    expect(text).toContain("Law");
    expect(text).toContain("CZ");
    expect(text).not.toContain("{{");
    // ZIP still opens as a valid package.
    const reopened = await JSZip.loadAsync(buffer);
    expect(reopened.file("word/document.xml")).not.toBeNull();
  });

  test("nested contracts → fields fills end-to-end", async () => {
    const docx = await makeDocx(
      WRAP(
        P("{{#each contracts}}") +
          P("Contract: {{contracts.name}}") +
          TBL(
            TR(TC(P("Field")), TC(P("Value"))),
            TR(
              TC(
                P("{{#each contracts.fields}}"),
                P("{{contracts.fields.label}}"),
              ),
              TC(P("{{contracts.fields.value}}"), P("{{/each}}")),
            ),
          ) +
          P("{{/each}}"),
      ),
    );
    const { buffer, unmatchedPlaceholders, structureErrors } =
      await fillTemplate(docx, {
        contracts: [
          {
            name: "NDA",
            fields: [
              { label: "Term", value: "2y" },
              { label: "Law", value: "CZ" },
            ],
          },
          { name: "MSA", fields: [{ label: "Fee", value: "1000" }] },
        ],
      });

    expect(structureErrors).toEqual([]);
    expect(unmatchedPlaceholders).toEqual([]);

    const text = await documentText(buffer);
    for (const expected of [
      "Contract: NDA",
      "Term",
      "2y",
      "Law",
      "CZ",
      "Contract: MSA",
      "Fee",
      "1000",
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain("{{");
  });
});
