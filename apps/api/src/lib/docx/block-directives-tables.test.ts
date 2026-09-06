import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import JSZip from "jszip";
import * as slimdom from "slimdom";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

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

/**
 * Cells left without a `w:p`. OOXML requires every `w:tc` to carry at least one
 * block-level child; Word reports a document that breaks this as corrupt, so
 * the count must stay 0 after any directive pruning.
 */
const emptyCellCount = (body: slimdom.Element): number =>
  [...body.getElementsByTagNameNS(W_NS, "tc")].filter(
    (tc) => tc.getElementsByTagNameNS(W_NS, "p").length === 0,
  ).length;

/** Tables left without a `w:tr` — the same corruption one level up. */
const emptyTableCount = (body: slimdom.Element): number =>
  [...body.getElementsByTagNameNS(W_NS, "tbl")].filter(
    (tbl) => tbl.getElementsByTagNameNS(W_NS, "tr").length === 0,
  ).length;

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

  test("{{#if}} opening in a row and closing outside the table → structure error", () => {
    const xml = WRAP(
      TBL(TR(TC(P("{{#if flag}}")))) + P("Body text") + P("{{/if}}"),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, { flag: true });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toContain("table");
    expect(errors[0]?.directive).toBe("{{#if flag}}");
    // Markers neutralized: nothing left for the scanner to re-open.
    const texts = bodyTexts(body);
    expect(texts).not.toContain("{{#if flag}}");
    expect(texts).not.toContain("{{/if}}");
    expect(emptyCellCount(body)).toBe(0);
  });

  test("{{#if}} spanning two rows → structure error, every branch marker cleared", () => {
    const xml = WRAP(
      TBL(
        TR(TC(P("{{#if flag}}"), P("Yes"))),
        TR(TC(P("{{#else}}"), P("No"), P("{{/if}}"))),
      ),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, { flag: false });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toContain("table");
    const texts = bodyTexts(body);
    expect(texts).not.toContain("{{#if flag}}");
    expect(texts).not.toContain("{{#else}}");
    expect(texts).not.toContain("{{/if}}");
  });

  test.each([
    ["else", "{{#else}}"],
    ["elseif", "{{#elseif fallback}}"],
  ])(
    "a nested-row %s marker rejects the outer-row conditional without pruning content",
    (_kind, branchMarker) => {
      const xml = WRAP(
        TBL(
          TR(
            TC(
              P("{{#if flag}}"),
              P("Outer before"),
              TBL(TR(TC(P(branchMarker), P("Nested content")))),
              P("Outer after"),
              P("{{/if}}"),
            ),
          ),
        ),
      );
      const body = parseBody(xml);
      const { errors } = processBlockDirectives(body, {
        fallback: true,
        flag: false,
      });

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.message).toContain("table");
      expect(rowCount(body)).toBe(2);
      expect(tableCount(body)).toBe(2);
      expect(emptyCellCount(body)).toBe(0);
      expect(emptyTableCount(body)).toBe(0);
      expect(bodyTexts(body)).toEqual([
        "",
        "Outer before",
        "",
        "Nested content",
        "Outer after",
        "",
      ]);
    },
  );
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

// ── {{#if}} branch pruning removes whole tables ──────────

describe("processBlockDirectives — if-branch table pruning", () => {
  test("losing {{#if}} branch's table is removed, not left as a shell", () => {
    const xml = WRAP(
      P("{{#if hasVerdicts}}") +
        TBL(TR(TC(P("Field")), TC(P("Value")), TC(P("Verdict")))) +
        P("{{#else}}") +
        TBL(TR(TC(P("Field")), TC(P("Value")))) +
        P("{{/if}}"),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, { hasVerdicts: false });

    expect(errors).toEqual([]);
    // Only the else (2-column) table survives; no empty shell from the if branch.
    expect(tableCount(body)).toBe(1);
    const texts = bodyTexts(body);
    expect(texts).not.toContain("Verdict");
    expect(texts).toContain("Field");
    expect(texts).toContain("Value");
    // Directive markers are gone.
    expect(texts).not.toContain("{{#if hasVerdicts}}");
    expect(texts).not.toContain("{{/if}}");
  });

  test("winning {{#if}} branch's table is kept, else branch's table dropped", () => {
    const xml = WRAP(
      P("{{#if hasVerdicts}}") +
        TBL(TR(TC(P("Field")), TC(P("Value")), TC(P("Verdict")))) +
        P("{{#else}}") +
        TBL(TR(TC(P("Field")), TC(P("Value")))) +
        P("{{/if}}"),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, { hasVerdicts: true });

    expect(errors).toEqual([]);
    expect(tableCount(body)).toBe(1);
    expect(bodyTexts(body)).toContain("Verdict");
  });

  test("if-false with a single table and no else removes the table entirely", () => {
    const xml = WRAP(
      P("Intro") +
        P("{{#if hasVerdicts}}") +
        TBL(TR(TC(P("Verdict table")))) +
        P("{{/if}}") +
        P("Outro"),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, { hasVerdicts: false });

    expect(errors).toEqual([]);
    expect(tableCount(body)).toBe(0);
    expect(bodyTexts(body)).toEqual(["Intro", "Outro"]);
  });
});

// ── {{#if}} confined to a table row ──────────────────────

// A bilingual scope table: one scope item per row, Polish cell | English cell,
// the whole row wrapped in a conditional that opens in the first cell and
// closes in the last.
const bilingualScopeRow = TR(
  TC(P("{{#if scope.analysis}}"), P("Analiza umowy")),
  TC(P("Contract analysis"), P("{{/if}}")),
);
const bilingualScopeTable = TBL(
  TR(TC(P("Zakres")), TC(P("Scope"))),
  bilingualScopeRow,
);

describe("processBlockDirectives — table-row conditionals", () => {
  test("a false condition removes the whole row", () => {
    const body = parseBody(WRAP(bilingualScopeTable));
    const { errors } = processBlockDirectives(body, {
      scope: { analysis: false },
    });

    expect(errors).toEqual([]);
    expect(rowCount(body)).toBe(1);
    expect(bodyTexts(body)).toEqual(["Zakres", "Scope"]);
    expect(emptyCellCount(body)).toBe(0);
  });

  test("a true condition keeps the row and strips the marker paragraphs", () => {
    const body = parseBody(WRAP(bilingualScopeTable));
    const { errors } = processBlockDirectives(body, {
      scope: { analysis: true },
    });

    expect(errors).toEqual([]);
    expect(rowCount(body)).toBe(2);
    expect(bodyTexts(body)).toEqual([
      "Zakres",
      "Scope",
      "Analiza umowy",
      "Contract analysis",
    ]);
    expect(emptyCellCount(body)).toBe(0);
  });

  test("markers inside one cell still condition the whole row", () => {
    const xml = WRAP(
      TBL(
        TR(TC(P("Zakres")), TC(P("Scope"))),
        TR(
          TC(P("Analiza umowy")),
          TC(P("{{#if scope.analysis}}"), P("Contract analysis"), P("{{/if}}")),
        ),
      ),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, {
      scope: { analysis: false },
    });

    expect(errors).toEqual([]);
    // The row is the unit: the Polish cell goes with it.
    expect(rowCount(body)).toBe(1);
    expect(bodyTexts(body)).toEqual(["Zakres", "Scope"]);
  });

  test("an {{#else}} branch inside a row keeps the row and the else content", () => {
    const xml = WRAP(
      TBL(
        TR(
          TC(P("{{#if scope.analysis}}"), P("Analiza umowy")),
          TC(P("Contract analysis"), P("{{#else}}")),
          TC(P("Brak"), P("None"), P("{{/if}}")),
        ),
      ),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, {
      scope: { analysis: false },
    });

    expect(errors).toEqual([]);
    expect(rowCount(body)).toBe(1);
    // The two cells the losing branch occupied are emptied but keep a
    // paragraph each, so the row stays valid OOXML.
    expect(bodyTexts(body)).toEqual(["", "", "Brak", "None"]);
    expect(emptyCellCount(body)).toBe(0);
  });

  test("a cell left with no paragraph is backfilled with an empty one", () => {
    const xml = WRAP(
      TBL(
        TR(
          TC(P("{{#if scope.analysis}}")),
          TC(P("Analiza umowy")),
          TC(P("Contract analysis"), P("{{/if}}")),
        ),
      ),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, {
      scope: { analysis: true },
    });

    expect(errors).toEqual([]);
    expect(rowCount(body)).toBe(1);
    // Three cells survive; the marker-only cell keeps an empty paragraph.
    expect(body.getElementsByTagNameNS(W_NS, "tc").length).toBe(3);
    expect(emptyCellCount(body)).toBe(0);
    expect(bodyTexts(body)).toEqual(["", "Analiza umowy", "Contract analysis"]);
  });

  test("content in cells between the markers belongs to the block", () => {
    const xml = WRAP(
      TBL(
        TR(
          TC(P("{{#if scope.analysis}}")),
          TC(P("Analiza umowy")),
          TC(P("Contract analysis"), P("{{/if}}")),
        ),
      ),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, {
      scope: { analysis: false },
    });

    expect(errors).toEqual([]);
    // Row gone, and with it the table that had no other row.
    expect(rowCount(body)).toBe(0);
    expect(bodyTexts(body)).toEqual([]);
  });

  test("a false condition in a single-row table removes the table shell", () => {
    const xml = WRAP(
      P("Intro") +
        TBL(TR(TC(P("{{#if scope.analysis}}"), P("Analiza"), P("{{/if}}")))) +
        P("Outro"),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, {
      scope: { analysis: false },
    });

    expect(errors).toEqual([]);
    expect(tableCount(body)).toBe(0);
    expect(emptyTableCount(body)).toBe(0);
    expect(bodyTexts(body)).toEqual(["Intro", "Outro"]);
  });

  test("a sibling block in a removed row never prunes content after the table", () => {
    // Two sequential blocks share the row. The later one loses, so the row —
    // and with it the earlier block's paragraphs — is removed. The earlier
    // block is still queued for this pass: it must resolve to those removed
    // paragraphs, not to whatever now occupies their old positions.
    const xml = WRAP(
      TBL(
        TR(
          TC(
            P("{{#if scope.analysis}}"),
            P("Analiza"),
            P("{{/if}}"),
            P("{{#if scope.litigation}}"),
            P("Spory"),
            P("{{/if}}"),
          ),
        ),
      ) +
        P("After 1") +
        P("After 2") +
        P("After 3"),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, {
      scope: { analysis: true, litigation: false },
    });

    expect(errors).toEqual([]);
    expect(tableCount(body)).toBe(0);
    expect(bodyTexts(body)).toEqual(["After 1", "After 2", "After 3"]);
  });

  test("a row behind a content-control wrapper takes its table with it", () => {
    // Word wraps a row-level content control as `w:tbl > w:sdt > w:sdtContent >
    // w:tr`, so the emptied table is an ancestor of the removed row, not its
    // parent.
    const wrappedRow = (row: string) =>
      `<w:sdt><w:sdtContent>${row}</w:sdtContent></w:sdt>`;
    const xml = WRAP(
      P("Intro") +
        TBL(
          wrappedRow(
            TR(TC(P("{{#if scope.analysis}}"), P("Analiza"), P("{{/if}}"))),
          ),
        ) +
        P("Outro"),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, {
      scope: { analysis: false },
    });

    expect(errors).toEqual([]);
    expect(tableCount(body)).toBe(0);
    expect(emptyTableCount(body)).toBe(0);
    expect(bodyTexts(body)).toEqual(["Intro", "Outro"]);
  });

  test("markers Word split across runs still bind to the row", () => {
    // Word splits a marker into several `w:r` runs after an edit or a
    // spell-check pass. The scanner joins a paragraph's run text, so the block
    // is recognized and the row is still the unit.
    const splitOpener =
      "<w:p><w:r><w:t>{{#if </w:t></w:r><w:r><w:t>scope.analysis}}</w:t></w:r></w:p>";
    const splitCloser =
      "<w:p><w:r><w:t>{{/</w:t></w:r><w:r><w:t>if}}</w:t></w:r></w:p>";
    const xml = WRAP(
      TBL(
        TR(TC(P("Zakres")), TC(P("Scope"))),
        TR(
          TC(splitOpener, P("Analiza umowy")),
          TC(P("Contract analysis"), splitCloser),
        ),
      ),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, {
      scope: { analysis: false },
    });

    expect(errors).toEqual([]);
    expect(rowCount(body)).toBe(1);
    expect(bodyTexts(body)).toEqual(["Zakres", "Scope"]);
  });

  test("a nested row conditional inside a row-repeat drops only its own rows", () => {
    const xml = WRAP(
      TBL(
        TR(TC(P("Zakres")), TC(P("Scope"))),
        TR(
          TC(
            P("{{#each items}}"),
            P("{{#if items.include}}"),
            P("{{items.pl}}"),
          ),
          TC(P("{{items.en}}"), P("{{/if}}"), P("{{/each}}")),
        ),
      ),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, {
      items: [
        { include: true, pl: "Analiza", en: "Analysis" },
        { include: false, pl: "Ukryte", en: "Hidden" },
        { include: true, pl: "Doradztwo", en: "Advisory" },
      ],
    });

    expect(errors).toEqual([]);
    // Header + the two rows whose item passed the condition.
    expect(rowCount(body)).toBe(3);
    expect(emptyCellCount(body)).toBe(0);
    const texts = bodyTexts(body);
    expect(texts).toContain("{{__each_items_0_pl}}");
    expect(texts).toContain("{{__each_items_2_en}}");
    expect(texts).not.toContain("{{__each_items_1_pl}}");
    expect(texts.join("|")).not.toContain("{{#if");
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

  test("a bilingual scope table keeps only the rows whose condition holds", async () => {
    const docx = await makeDocx(
      WRAP(
        TBL(
          TR(TC(P("Zakres")), TC(P("Scope"))),
          TR(
            TC(P("{{#if scope.analysis}}"), P("Analiza umowy")),
            TC(P("Contract analysis"), P("{{/if}}")),
          ),
          TR(
            TC(P("{{#if scope.litigation}}"), P("Spory sądowe")),
            TC(P("Litigation"), P("{{/if}}")),
          ),
        ),
      ),
    );
    const { buffer, unmatchedPlaceholders, structureErrors } =
      await fillTemplate(docx, {
        scope: { analysis: true, litigation: false },
      });

    expect(structureErrors).toEqual([]);
    expect(unmatchedPlaceholders).toEqual([]);

    const text = await documentText(buffer);
    expect(text).toContain("Analiza umowy");
    expect(text).toContain("Contract analysis");
    expect(text).not.toContain("Spory sądowe");
    expect(text).not.toContain("Litigation");
    expect(text).not.toContain("{{");

    // The filled package still parses, and no cell lost its paragraph.
    const reopened = await JSZip.loadAsync(buffer);
    const filledXml =
      (await reopened.file("word/document.xml")?.async("string")) ?? "";
    const filledBody = parseBody(filledXml);
    expect(rowCount(filledBody)).toBe(2);
    expect(emptyCellCount(filledBody)).toBe(0);
    expect(emptyTableCount(filledBody)).toBe(0);
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

// ── Property: a row conditional never corrupts the table ─

describe("property: {{#if}} markers placed anywhere inside one row", () => {
  test(
    "no cell is left without a paragraph and no table without a row",
    () => {
      const placement = fc.record({
        cellPicks: fc.array(fc.integer({ min: 0, max: 2 }), {
          minLength: 7,
          maxLength: 7,
        }),
        flag: fc.boolean(),
        withElse: fc.boolean(),
      });

      fc.assert(
        fc.property(placement, ({ cellPicks, flag, withElse }) => {
          const tokens = withElse
            ? [
                "{{#if flag}}",
                "PL",
                "EN",
                "{{#else}}",
                "PL alt",
                "EN alt",
                "{{/if}}",
              ]
            : ["{{#if flag}}", "PL", "EN", "{{/if}}"];
          // A non-decreasing cell index keeps each cell's paragraphs contiguous
          // in document order, the only shape a real row can have.
          const picks = cellPicks
            .slice(0, tokens.length)
            .toSorted((a, b) => a - b);
          const byCell = new Map<number, string[]>();
          for (const [i, token] of tokens.entries()) {
            const cell = picks[i] ?? 0;
            const paragraphs = byCell.get(cell);
            if (paragraphs) {
              paragraphs.push(token);
            } else {
              byCell.set(cell, [token]);
            }
          }
          const cells = [...byCell.keys()]
            .toSorted((a, b) => a - b)
            .map((key) => TC(...(byCell.get(key) ?? []).map(P)));

          // The label cell sits outside the marker span: the row is the unit,
          // so it lives or dies with the conditional.
          const body = parseBody(WRAP(TBL(TR(TC(P("Label")), ...cells))));
          const { errors } = processBlockDirectives(body, { flag });

          expect(errors).toEqual([]);
          expect(emptyCellCount(body)).toBe(0);
          expect(emptyTableCount(body)).toBe(0);

          const texts = bodyTexts(body);
          expect(texts.join("|")).not.toContain("{{");
          if (flag) {
            expect(texts).toContain("PL");
            expect(texts).toContain("EN");
            expect(texts).not.toContain("PL alt");
          } else if (withElse) {
            expect(texts).toContain("PL alt");
            expect(texts).not.toContain("PL");
          } else {
            // The row was the block and the table's only row: both are gone.
            expect(texts).toEqual([]);
          }
        }),
        propertyConfig({ numRuns: 200, seed: propertySeed() }),
      );
    },
    propertyTestTimeout(15_000),
  );
});
