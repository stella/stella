import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fc from "fast-check";
import JSZip from "jszip";
import * as slimdom from "slimdom";

import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";

import { processBlockDirectives } from "./block-directives";
import { discoverTemplate } from "./discover-template";
import { processInlineConditions } from "./inline-conditions";
import { paragraphText, W_NS } from "./ooxml";
import type { TemplateData } from "./types";

setDefaultTimeout(propertyTestTimeout(30_000));

// ── Fixture builders ─────────────────────────────────────

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const TC = (...paragraphs: string[]) => `<w:tc>${paragraphs.join("")}</w:tc>`;
const TR = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;
const TBL = (...rows: string[]) => `<w:tbl>${rows.join("")}</w:tbl>`;

const makeDocx = async (documentXml: string): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

const parseBody = (xml: string): slimdom.Element => {
  const body = slimdom
    .parseXmlDocument(xml)
    .getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) {
    throw new Error("No w:body element found");
  }
  return body;
};

/** The full directive pipeline over one body, as patch-template runs it. */
const render = (xml: string, data: TemplateData) => {
  const body = parseBody(xml);
  const { errors, patchValues } = processBlockDirectives(body, data);
  const inlineErrors = processInlineConditions(body, data);
  return {
    blockErrors: errors,
    inlineErrors,
    patchValues,
    rowCount: body.getElementsByTagNameNS(W_NS, "tr").length,
    texts: [...body.getElementsByTagNameNS(W_NS, "p")].map(paragraphText),
  };
};

const HEADER_ROW = TR(TC(P("Deliverable")), TC(P("Fee")));

const EACH_ROW_FORM = WRAP(
  TBL(
    HEADER_ROW,
    TR(
      TC(P("{{#each deliverables}}{{deliverables.item}}")),
      TC(P("{{deliverables.fee}}{{/each}}")),
    ),
  ),
);

// ── Row-form {{#each}} ───────────────────────────────────

describe("row-form {{#each}} markers", () => {
  test("repeats the row per item and strips the markers", () => {
    const { blockErrors, inlineErrors, patchValues, rowCount, texts } = render(
      EACH_ROW_FORM,
      {
        deliverables: [
          { item: "Report", fee: "100" },
          { item: "Audit", fee: "200" },
          { item: "Filing", fee: "300" },
        ],
      },
    );

    expect(blockErrors).toEqual([]);
    expect(inlineErrors).toEqual([]);
    // header row + one row per item
    expect(rowCount).toBe(4);
    expect(texts).toEqual([
      "Deliverable",
      "Fee",
      "{{__each_deliverables_0_item}}",
      "{{__each_deliverables_0_fee}}",
      "{{__each_deliverables_1_item}}",
      "{{__each_deliverables_1_fee}}",
      "{{__each_deliverables_2_item}}",
      "{{__each_deliverables_2_fee}}",
    ]);
    expect(patchValues["__each_deliverables_2_fee"]).toBe("300");
  });

  test("an empty list removes the template row and keeps the header", () => {
    const { rowCount, texts } = render(EACH_ROW_FORM, { deliverables: [] });

    expect(rowCount).toBe(1);
    expect(texts).toEqual(["Deliverable", "Fee"]);
  });

  test("keeps the run formatting of the text around the markers", () => {
    const body = parseBody(
      WRAP(
        TBL(
          TR(
            TC(
              `<w:p><w:r><w:t>{{#each deliverables}}</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>{{deliverables.item}}</w:t></w:r></w:p>`,
            ),
            TC(P("{{deliverables.fee}}{{/each}}")),
          ),
        ),
      ),
    );
    processBlockDirectives(body, { deliverables: [{ item: "a", fee: "1" }] });

    const boldRuns = [...body.getElementsByTagNameNS(W_NS, "r")].filter(
      (run) => run.getElementsByTagNameNS(W_NS, "b").length > 0,
    );
    expect(boldRuns.map(paragraphText)).toEqual([
      "{{__each_deliverables_0_item}}",
    ]);
  });

  test("an opener with no closer in the row keeps today's error", () => {
    const { inlineErrors, rowCount } = render(
      WRAP(
        TBL(
          TR(
            TC(P("{{#each deliverables}}{{deliverables.item}}")),
            TC(P("Fee")),
          ),
        ),
      ),
      { deliverables: [{ item: "a" }] },
    );

    expect(rowCount).toBe(1);
    expect(inlineErrors).toEqual([
      {
        message:
          'Unclosed inline {{#each}} — the {{/each}} must be in the same paragraph in paragraph "{{#each deliverables}}{{deliverables.item}}"',
        paragraphIndex: 0,
        directive: "{{#each deliverables}}",
      },
    ]);
  });

  test("a closer with no opener in the row keeps today's error", () => {
    const { inlineErrors } = render(
      WRAP(TBL(TR(TC(P("Item")), TC(P("{{deliverables.fee}}{{/each}}"))))),
      { deliverables: [{ fee: "1" }] },
    );

    expect(inlineErrors).toEqual([
      {
        message:
          'Orphaned inline {{/each}} without an open {{#each}} in paragraph "{{deliverables.fee}}{{/each}}"',
        paragraphIndex: 1,
        directive: "{{/each}}",
      },
    ]);
  });

  test("text before the opener stays inline mode and errors as today", () => {
    const { inlineErrors, rowCount } = render(
      WRAP(
        TBL(
          TR(
            TC(P("Item: {{#each deliverables}}{{deliverables.item}}")),
            TC(P("{{deliverables.fee}}{{/each}}")),
          ),
        ),
      ),
      { deliverables: [{ item: "a", fee: "1" }] },
    );

    expect(rowCount).toBe(1);
    expect(inlineErrors.map(({ directive }) => directive)).toEqual([
      "{{#each deliverables}}",
      "{{/each}}",
    ]);
    expect(inlineErrors[0]?.message).toStartWith(
      "Unclosed inline {{#each}} — the {{/each}} must be in the same paragraph",
    );
  });

  test("two row blocks nested in one row report a structure error", () => {
    const { inlineErrors, rowCount } = render(
      WRAP(
        TBL(
          TR(
            TC(P("{{#each deliverables}}{{deliverables.item}}")),
            TC(P("{{#if paid}}paid")),
            TC(P("yes{{/if}}")),
            TC(P("{{deliverables.fee}}{{/each}}")),
          ),
        ),
      ),
      { deliverables: [{ item: "a", fee: "1" }], paid: true },
    );

    expect(rowCount).toBe(1);
    expect(inlineErrors.map(({ directive }) => directive)).toEqual([
      "{{#each deliverables}}",
      "{{#if paid}}",
      "{{/if}}",
      "{{/each}}",
    ]);
  });

  test("a pair straddling two rows is still refused", () => {
    const { blockErrors, inlineErrors } = render(
      WRAP(
        TBL(
          TR(TC(P("{{#each deliverables}}{{deliverables.item}}"))),
          TR(TC(P("{{deliverables.fee}}{{/each}}"))),
        ),
      ),
      { deliverables: [{ item: "a", fee: "1" }] },
    );

    expect(blockErrors).toEqual([]);
    expect(inlineErrors.map(({ directive }) => directive)).toEqual([
      "{{#each deliverables}}",
      "{{/each}}",
    ]);
  });
});

// ── Row-form {{#if}} ─────────────────────────────────────

describe("row-form {{#if}} markers", () => {
  const ifRowForm = WRAP(
    TBL(
      TR(TC(P("Clause")), TC(P("Amount"))),
      TR(TC(P("{{#if penalty}}Late fee")), TC(P("{{penalty_amount}}{{/if}}"))),
    ),
  );

  test("keeps the row with the markers stripped when the condition holds", () => {
    const { blockErrors, inlineErrors, rowCount, texts } = render(ifRowForm, {
      penalty: true,
      penalty_amount: "500",
    });

    expect(blockErrors).toEqual([]);
    expect(inlineErrors).toEqual([]);
    expect(rowCount).toBe(2);
    expect(texts).toEqual([
      "Clause",
      "Amount",
      "Late fee",
      "{{penalty_amount}}",
    ]);
  });

  test("removes the whole row when the condition fails", () => {
    const { rowCount, texts } = render(ifRowForm, {
      penalty: false,
      penalty_amount: "500",
    });

    expect(rowCount).toBe(1);
    expect(texts).toEqual(["Clause", "Amount"]);
  });

  test("a branch marker buried in a cell refuses the row and keeps the branch", () => {
    // Only the opener and closer are hoisted, so accepting this would drop
    // "Unpaid" with the row whenever the condition is false.
    for (const paid of [true, false]) {
      const { inlineErrors, rowCount, texts } = render(
        WRAP(
          TBL(
            TR(
              TC(P("{{#if paid}}Paid{{#else}}Unpaid")),
              TC(P("Amount{{/if}}")),
            ),
          ),
        ),
        { paid },
      );

      expect(rowCount).toBe(1);
      expect(texts).toEqual([
        "{{#if paid}}Paid{{#else}}Unpaid",
        "Amount{{/if}}",
      ]);
      expect(inlineErrors.map(({ directive }) => directive)).toEqual([
        "{{#if paid}}",
        "{{/if}}",
      ]);
    }
  });

  test("a pair wrapping one cell's paragraphs is not a row block", () => {
    const { inlineErrors, rowCount } = render(
      WRAP(TBL(TR(TC(P("{{#if penalty}}Late fee"), P("500{{/if}}"))))),
      { penalty: false },
    );

    expect(rowCount).toBe(1);
    expect(inlineErrors.map(({ directive }) => directive)).toEqual([
      "{{#if penalty}}",
      "{{/if}}",
    ]);
  });
});

// ── Reported paragraph positions ─────────────────────────

describe("diagnostics name the authored paragraph", () => {
  /** A table row plus a later paragraph whose inline `{{#if}}` never closes.
   *  The malformed paragraph is the third the author typed: two table cells,
   *  then it. */
  const withRow = (firstCell: string, secondCell: string) =>
    WRAP(
      TBL(TR(TC(P(firstCell)), TC(P(secondCell)))) +
        P("Buyer {{#if has_spouse}} and spouse"),
    );

  const AUTHORED_INDEX = 2;

  test("a row form before a malformed marker does not shift its index", async () => {
    const rowForm = await discoverTemplate(
      await makeDocx(
        withRow(
          "{{#each deliverables}}{{deliverables.item}}",
          "{{deliverables.fee}}{{/each}}",
        ),
      ),
    );
    const noBlock = await discoverTemplate(
      await makeDocx(withRow("Item", "Fee")),
    );

    // Normalization hoists two marker paragraphs into the row; neither may take
    // a position of its own, because extractText and the preview still address
    // the authored file.
    expect(rowForm.structureErrors.map((e) => e.paragraphIndex)).toEqual([
      AUTHORED_INDEX,
    ]);
    expect(noBlock.structureErrors.map((e) => e.paragraphIndex)).toEqual([
      AUTHORED_INDEX,
    ]);
  });

  test("a split-marker warning after a row form names the authored paragraph", async () => {
    const result = await discoverTemplate(
      await makeDocx(
        WRAP(
          TBL(
            TR(
              TC(P("{{#each deliverables}}{{deliverables.item}}")),
              TC(P("{{deliverables.fee}}{{/each}}")),
            ),
          ) + P("Total {{amount"),
        ),
      ),
    );

    expect(result.warnings.map(({ code }) => code)).toEqual(["split_marker"]);
    expect(result.warnings[0]?.message).toContain(
      `paragraph ${AUTHORED_INDEX}`,
    );
  });
});

// ── Equivalence with the own-paragraph form ──────────────

describe("row form and own-paragraph form agree", () => {
  const eachRowXml = WRAP(
    TBL(
      HEADER_ROW,
      TR(
        TC(P("{{#each deliverables}}{{deliverables.item}}")),
        TC(P("{{deliverables.fee}}{{/each}}")),
      ),
    ),
  );
  const eachParagraphXml = WRAP(
    TBL(
      HEADER_ROW,
      TR(
        TC(P("{{#each deliverables}}"), P("{{deliverables.item}}")),
        TC(P("{{deliverables.fee}}"), P("{{/each}}")),
      ),
    ),
  );
  const ifRowXml = WRAP(
    TBL(
      HEADER_ROW,
      TR(TC(P("{{#if penalty}}Late fee")), TC(P("{{penalty_amount}}{{/if}}"))),
    ),
  );
  const ifParagraphXml = WRAP(
    TBL(
      HEADER_ROW,
      TR(
        TC(P("{{#if penalty}}"), P("Late fee")),
        TC(P("{{penalty_amount}}"), P("{{/if}}")),
      ),
    ),
  );

  const item = fc.record({
    item: fc.string({ maxLength: 8 }).filter((s) => !s.includes("{")),
    fee: fc.string({ maxLength: 8 }).filter((s) => !s.includes("{")),
  });

  test("the two placements render the same rows for the same values", () => {
    fc.assert(
      fc.property(
        fc.array(item, { maxLength: 5 }),
        fc.boolean(),
        (deliverables, penalty) => {
          const data = { deliverables, penalty, penalty_amount: "500" };
          for (const [rowXml, paragraphXml] of [
            [eachRowXml, eachParagraphXml],
            [ifRowXml, ifParagraphXml],
          ] as const) {
            const rowForm = render(rowXml, data);
            const paragraphForm = render(paragraphXml, data);
            expect(rowForm.blockErrors).toEqual([]);
            expect(rowForm.inlineErrors).toEqual([]);
            expect(rowForm.texts).toEqual(paragraphForm.texts);
            expect(rowForm.rowCount).toBe(paragraphForm.rowCount);
            expect(rowForm.patchValues).toEqual(paragraphForm.patchValues);
          }
        },
      ),
      propertyConfig({ numRuns: 50 }),
    );
  });
});
