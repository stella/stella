/**
 * Edge-case tests for OOXML structures that real-world DOCX
 * files contain. Each test targets a specific structural
 * pattern and verifies the engine handles it correctly.
 *
 * Tests are grouped by edge case. Failures indicate a real
 * gap in the engine; passing tests confirm the pattern is
 * already handled.
 */

import { describe, expect, test } from "bun:test";
import * as slimdom from "slimdom";

import { applyEdits } from "./apply-edits";
import { diffParagraphs } from "./diff-paragraphs";
import { injectComments } from "./inject-comments";
import { createIdGenerator, W_NS } from "./ooxml";
import { buildRunMap } from "./run-map";
import type { DocxComment, RevisionAuthor } from "./types";

const AUTHOR: RevisionAuthor = {
  name: "stella AI",
  date: "2026-02-17T12:00:00Z",
};

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="${W_NS}">` +
  `<w:body>${body}</w:body></w:document>`;

/** Parse XML and return the first w:p element. */
const firstParagraph = (xml: string): slimdom.Element => {
  const doc = slimdom.parseXmlDocument(xml);
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) {
    throw new Error("No w:body element found");
  }
  const p = body.getElementsByTagNameNS(W_NS, "p")[0];
  if (!p) {
    throw new Error("No w:p element found");
  }
  return p;
};

/** Extract "accepted" text from paragraphs in edited XML. */
const extractAcceptedText = (xml: string): string[] => {
  const doc = slimdom.parseXmlDocument(xml);
  const body = doc.getElementsByTagNameNS(W_NS, "body").at(0);
  if (!body) {
    return [];
  }

  const texts: string[] = [];
  for (const child of body.childNodes) {
    if (!(child instanceof slimdom.Element)) {
      continue;
    }
    const el = child;
    if (el.localName !== "p" || el.namespaceURI !== W_NS) {
      continue;
    }

    let text = "";
    const walk = (node: slimdom.Node) => {
      if (!(node instanceof slimdom.Element)) {
        return;
      }
      const n = node;
      if (n.localName === "del" && n.namespaceURI === W_NS) {
        return;
      }
      if (n.localName === "t" && n.namespaceURI === W_NS) {
        text += n.textContent ?? "";
      } else {
        for (const c of n.childNodes) {
          walk(c);
        }
      }
    };
    walk(el);
    texts.push(text);
  }
  return texts;
};

// ── Edge case 1: Runs inside w:hyperlink ─────────────────

describe("edge case: runs inside w:hyperlink", () => {
  const HYPERLINK_XML = WRAP(
    "<w:p>" +
      `<w:r><w:t xml:space="preserve">Click </w:t></w:r>` +
      "<w:hyperlink>" +
      `<w:r><w:t xml:space="preserve">here</w:t></w:r>` +
      "</w:hyperlink>" +
      `<w:r><w:t xml:space="preserve"> to continue</w:t></w:r>` +
      "</w:p>",
  );

  test("buildRunMap includes text inside w:hyperlink", () => {
    const p = firstParagraph(HYPERLINK_XML);
    const spans = buildRunMap(p);
    const fullText = spans.map((s) => s.tNode.textContent).join("");
    expect(fullText).toBe("Click here to continue");
  });

  test("editing text after hyperlink has correct offset", () => {
    const oldText = "Click here to continue";
    const newText = "Click here to proceed";

    const extracted = {
      paragraphs: [{ index: 0, text: oldText }],
      charCount: oldText.length,
      view: "accepted" as const,
    };

    const { edits } = diffParagraphs(extracted, [
      { paragraphIndex: 0, newText },
    ]);

    const idGen = createIdGenerator(new Set());
    const result = applyEdits(HYPERLINK_XML, edits, AUTHOR, idGen);
    const accepted = extractAcceptedText(result);
    expect(accepted[0]).toBe(newText);
  });
});

// ── Edge case 2: Runs inside w:sdt (content control) ─────

describe("edge case: runs inside w:sdt", () => {
  const SDT_XML = WRAP(
    "<w:p>" +
      `<w:r><w:t xml:space="preserve">Name: </w:t></w:r>` +
      "<w:sdt><w:sdtContent>" +
      `<w:r><w:t xml:space="preserve">John Doe</w:t></w:r>` +
      "</w:sdtContent></w:sdt>" +
      "</w:p>",
  );

  test("buildRunMap includes text inside w:sdt", () => {
    const p = firstParagraph(SDT_XML);
    const spans = buildRunMap(p);
    const fullText = spans.map((s) => s.tNode.textContent).join("");
    expect(fullText).toBe("Name: John Doe");
  });
});

// ── Edge case 3: w:fldSimple wrapping runs ───────────────

describe("edge case: runs inside w:fldSimple", () => {
  const FLD_XML = WRAP(
    "<w:p>" +
      `<w:r><w:t xml:space="preserve">See </w:t></w:r>` +
      `<w:fldSimple w:instr=" REF _Ref123 ">` +
      `<w:r><w:t xml:space="preserve">Section 1</w:t></w:r>` +
      "</w:fldSimple>" +
      `<w:r><w:t xml:space="preserve"> for details</w:t></w:r>` +
      "</w:p>",
  );

  test("buildRunMap includes text inside w:fldSimple", () => {
    const p = firstParagraph(FLD_XML);
    const spans = buildRunMap(p);
    const fullText = spans.map((s) => s.tNode.textContent).join("");
    expect(fullText).toBe("See Section 1 for details");
  });
});

// ── Edge case 4: w:moveFrom / w:moveTo ───────────────────

describe("edge case: move revisions (w:moveFrom / w:moveTo)", () => {
  const MOVE_XML = WRAP(
    "<w:p>" +
      `<w:r><w:t xml:space="preserve">Start </w:t></w:r>` +
      `<w:moveFrom w:id="100" w:author="A" w:date="2026-01-01T00:00:00Z">` +
      `<w:r><w:t xml:space="preserve">moved away</w:t></w:r>` +
      "</w:moveFrom>" +
      `<w:moveTo w:id="101" w:author="A" w:date="2026-01-01T00:00:00Z">` +
      `<w:r><w:t xml:space="preserve">moved here</w:t></w:r>` +
      "</w:moveTo>" +
      `<w:r><w:t xml:space="preserve"> end</w:t></w:r>` +
      "</w:p>",
  );

  test("buildRunMap skips w:moveFrom (like w:del)", () => {
    const p = firstParagraph(MOVE_XML);
    const spans = buildRunMap(p);
    const fullText = spans.map((s) => s.tNode.textContent).join("");
    // Accepted view: moveFrom excluded, moveTo included
    expect(fullText).toBe("Start moved here end");
  });
});

// ── Edge case 5: w:id overflow past 2^31-1 ──────────────

describe("edge case: w:id overflow past INT32_MAX", () => {
  const INT32_MAX = 2_147_483_647;

  test("ID generator produces IDs above INT32_MAX", () => {
    const existing = new Set([INT32_MAX - 1]);
    const gen = createIdGenerator(existing);

    // First generated ID should be INT32_MAX
    const id1 = gen();
    expect(id1).toBe(INT32_MAX);

    // Next ID overflows past INT32_MAX
    const id2 = gen();
    // This test documents whether we handle the overflow
    expect(id2).toBeLessThanOrEqual(INT32_MAX);
  });
});

// ── Edge case 6: w:rPrChange IDs duplicated on split ─────

describe("edge case: w:rPrChange IDs duplicated on run split", () => {
  // A run with formatting change tracking
  const RPR_CHANGE_XML = WRAP(
    "<w:p>" +
      "<w:r>" +
      "<w:rPr>" +
      "<w:b/>" +
      `<w:rPrChange w:id="50" w:author="A" w:date="2026-01-01T00:00:00Z">` +
      "<w:rPr/>" +
      "</w:rPrChange>" +
      "</w:rPr>" +
      `<w:t xml:space="preserve">bold text here</w:t>` +
      "</w:r>" +
      "</w:p>",
  );

  test("splitting a run with w:rPrChange doesn't duplicate IDs", () => {
    const oldText = "bold text here";
    const newText = "bold new here";

    const extracted = {
      paragraphs: [{ index: 0, text: oldText }],
      charCount: oldText.length,
      view: "accepted" as const,
    };

    const { edits } = diffParagraphs(extracted, [
      { paragraphIndex: 0, newText },
    ]);

    const idGen = createIdGenerator(new Set([50]));
    const result = applyEdits(RPR_CHANGE_XML, edits, AUTHOR, idGen);

    // Check for duplicate w:id values
    const doc = slimdom.parseXmlDocument(result);
    const allIds: number[] = [];
    const walk = (node: slimdom.Node) => {
      if (node instanceof slimdom.Element) {
        const el = node;
        const id = el.getAttributeNS(W_NS, "id") ?? el.getAttribute("w:id");
        if (id !== null) {
          const parsed = Number.parseInt(id, 10);
          if (!Number.isNaN(parsed)) {
            allIds.push(parsed);
          }
        }
      }
      for (const child of node.childNodes) {
        walk(child);
      }
    };
    walk(doc);

    expect(allIds.length).toBe(new Set(allIds).size);
  });

  test("split w:rPrChange elements retain valid w:id", () => {
    const oldText = "bold text here";
    const newText = "bold new here";

    const extracted = {
      paragraphs: [{ index: 0, text: oldText }],
      charCount: oldText.length,
      view: "accepted" as const,
    };

    const { edits } = diffParagraphs(extracted, [
      { paragraphIndex: 0, newText },
    ]);

    const idGen = createIdGenerator(new Set([50]));
    const result = applyEdits(RPR_CHANGE_XML, edits, AUTHOR, idGen);

    // Every w:rPrChange must have a w:id attribute
    const doc = slimdom.parseXmlDocument(result);
    const rPrChanges = doc.getElementsByTagNameNS(W_NS, "rPrChange");
    for (const el of rPrChanges) {
      const id = el.getAttributeNS(W_NS, "id") ?? el.getAttribute("w:id");
      expect(id).not.toBeNull();
    }
  });
});

// ── Edge case 7: Paragraphs inside tables ────────────────

describe("edge case: paragraphs inside tables", () => {
  const TABLE_XML = WRAP(
    `<w:p><w:r><w:t xml:space="preserve">Before table</w:t></w:r></w:p>` +
      "<w:tbl>" +
      "<w:tr><w:tc>" +
      `<w:p><w:r><w:t xml:space="preserve">Cell text</w:t></w:r></w:p>` +
      "</w:tc></w:tr>" +
      "</w:tbl>" +
      `<w:p><w:r><w:t xml:space="preserve">After table</w:t></w:r></w:p>`,
  );

  test("editing paragraph after table uses correct index", () => {
    // The engine indexes only body-level w:p elements.
    // paragraph 0 = "Before table", paragraph 1 = "After table"
    // Table paragraphs should be excluded.
    const extracted = {
      paragraphs: [
        { index: 0, text: "Before table" },
        { index: 1, text: "After table" },
      ],
      charCount: 23,
      view: "accepted" as const,
    };

    const { edits } = diffParagraphs(extracted, [
      { paragraphIndex: 1, newText: "After the table" },
    ]);

    const idGen = createIdGenerator(new Set());
    const result = applyEdits(TABLE_XML, edits, AUTHOR, idGen);
    const accepted = extractAcceptedText(result);

    // paragraph 0 unchanged
    expect(accepted[0]).toBe("Before table");
    // paragraph 1 (after table) edited correctly
    expect(accepted[1]).toBe("After the table");
  });
});

// ── Edge case 8: w:smartTag wrapping runs ────────────────

describe("edge case: runs inside w:smartTag", () => {
  const SMART_TAG_XML = WRAP(
    "<w:p>" +
      `<w:r><w:t xml:space="preserve">Date: </w:t></w:r>` +
      "<w:smartTag>" +
      `<w:r><w:t xml:space="preserve">January 1, 2026</w:t></w:r>` +
      "</w:smartTag>" +
      "</w:p>",
  );

  test("buildRunMap includes text inside w:smartTag", () => {
    const p = firstParagraph(SMART_TAG_XML);
    const spans = buildRunMap(p);
    const fullText = spans.map((s) => s.tNode.textContent).join("");
    expect(fullText).toBe("Date: January 1, 2026");
  });
});

// ── Edge case 9: Complex field codes ─────────────────────

describe("edge case: complex field codes (w:fldChar)", () => {
  // PAGE field: begin → instrText → separate → result → end
  const FIELD_XML = WRAP(
    "<w:p>" +
      `<w:r><w:t xml:space="preserve">Page </w:t></w:r>` +
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
      `<w:r><w:t xml:space="preserve">3</w:t></w:r>` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
      `<w:r><w:t xml:space="preserve"> of 10</w:t></w:r>` +
      "</w:p>",
  );

  test("buildRunMap includes field result text but not instrText", () => {
    const p = firstParagraph(FIELD_XML);
    const spans = buildRunMap(p);
    const fullText = spans.map((s) => s.tNode.textContent).join("");
    // instrText should NOT appear in the map; field result ("3") should
    expect(fullText).toBe("Page 3 of 10");
  });
});

// ── Edge case 10: Delete inside multi-run wrapper ────────

describe("edge case: delete inside multi-run wrapper preserves siblings", () => {
  // Hyperlink with two runs: editing one must not destroy the other
  const MULTI_RUN_LINK = WRAP(
    "<w:p>" +
      `<w:r><w:t xml:space="preserve">See </w:t></w:r>` +
      "<w:hyperlink>" +
      `<w:r><w:t xml:space="preserve">click </w:t></w:r>` +
      `<w:r><w:t xml:space="preserve">here</w:t></w:r>` +
      "</w:hyperlink>" +
      `<w:r><w:t xml:space="preserve"> now</w:t></w:r>` +
      "</w:p>",
  );

  test("replacing text in first hyperlink run preserves second", () => {
    const oldText = "See click here now";
    const newText = "See tap here now";

    const extracted = {
      paragraphs: [{ index: 0, text: oldText }],
      charCount: oldText.length,
      view: "accepted" as const,
    };

    const { edits } = diffParagraphs(extracted, [
      { paragraphIndex: 0, newText },
    ]);

    const idGen = createIdGenerator(new Set());
    const result = applyEdits(MULTI_RUN_LINK, edits, AUTHOR, idGen);
    const accepted = extractAcceptedText(result);
    expect(accepted[0]).toBe(newText);
  });
});

// ── Edge case 11: Comment on deeply nested run ───────────

describe("edge case: comment on run inside nested wrappers", () => {
  // Run nested: p > hyperlink > ins > r (two levels deep)
  const NESTED_XML = WRAP(
    "<w:p>" +
      `<w:r><w:t xml:space="preserve">Before </w:t></w:r>` +
      "<w:hyperlink>" +
      `<w:ins w:id="200" w:author="A" w:date="2026-01-01T00:00:00Z">` +
      `<w:r><w:t xml:space="preserve">linked text</w:t></w:r>` +
      "</w:ins>" +
      "</w:hyperlink>" +
      `<w:r><w:t xml:space="preserve"> after</w:t></w:r>` +
      "</w:p>",
  );

  test("injectComments does not crash on deeply nested run", () => {
    const comments: DocxComment[] = [
      {
        paragraphIndex: 0,
        charOffset: 7,
        length: 6,
        text: "Check this link",
      },
    ];

    const idGen = createIdGenerator(new Set([200]));
    // Should not throw NotFoundError
    const { documentXml } = injectComments(
      NESTED_XML,
      null,
      comments,
      AUTHOR,
      idGen,
    );

    // Verify comment range elements were inserted
    const doc = slimdom.parseXmlDocument(documentXml);
    const starts = doc.getElementsByTagNameNS(W_NS, "commentRangeStart");
    expect(starts.length).toBe(1);
  });
});

// ── Edge case 12: ID generator wraparound tracking ───────

describe("edge case: ID generator tracks its own output", () => {
  const INT32_MAX = 2_147_483_647;

  test("wraparound does not reissue previously generated IDs", () => {
    // Start near INT32_MAX so we wrap quickly
    const existing = new Set([INT32_MAX - 2]);
    const gen = createIdGenerator(existing);

    const generated: number[] = [];
    // Generate 5 IDs (will wrap past INT32_MAX)
    for (let i = 0; i < 5; i++) {
      generated.push(gen());
    }

    // All generated IDs must be unique
    expect(generated.length).toBe(new Set(generated).size);
  });
});
