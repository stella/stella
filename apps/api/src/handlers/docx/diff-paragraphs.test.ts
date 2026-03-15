import { describe, expect, test } from "bun:test";

import { applyEdits } from "./apply-edits";
import { diffParagraphs } from "./diff-paragraphs";
import { createIdGenerator } from "./ooxml";
import type {
  ExtractedDocument,
  ParagraphRewrite,
  RevisionAuthor,
} from "./types";

const AUTHOR: RevisionAuthor = {
  name: "Stella AI",
  date: "2026-02-17T12:00:00Z",
};

const extracted: ExtractedDocument = {
  paragraphs: [
    {
      index: 0,
      text: "The Purchase Price shall be one million Czech crowns (CZK 1,000,000).",
    },
    {
      index: 1,
      text: "The Closing Date shall be 31 March 2026.",
    },
    {
      index: 2,
      text: "The Seller represents and warrants that the Shares are free from all encumbrances.",
    },
    {
      index: 3,
      text: "This Agreement shall remain in effect for a period of two (2) years from the Effective Date.",
    },
    {
      index: 4,
      text: "The Receiving Party shall not disclose any Confidential Information to third parties without prior written consent.",
    },
  ],
  charCount: 400,
  view: "accepted",
};

describe("diffParagraphs", () => {
  test("word replacement produces replace edits", () => {
    const rewrites: ParagraphRewrite[] = [
      {
        paragraphIndex: 0,
        newText:
          "The Purchase Price shall be two million Czech crowns (CZK 2,000,000).",
      },
    ];

    const { edits } = diffParagraphs(extracted, rewrites);

    // "one" → "two" and "1,000,000" → "2,000,000"
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits.every((e) => e.kind === "replace")).toBe(true);
    const texts = edits
      .filter((e) => e.kind === "replace")
      .map((e) => (e as { text: string }).text);
    expect(texts).toContain("two");
  });

  test("date replacement → clean word-level replace", () => {
    const rewrites: ParagraphRewrite[] = [
      {
        paragraphIndex: 1,
        newText: "The Closing Date shall be 30 June 2026.",
      },
    ];

    const { edits } = diffParagraphs(extracted, rewrites);

    // "31 March" → "30 June" as a single replace
    expect(edits.length).toBe(1);
    const edit0 = edits[0];
    expect(edit0).toBeDefined();
    expect(edit0?.kind).toBe("replace");
    if (edit0?.kind === "replace") {
      expect(edit0.text).toBe("30 June");
      expect(edit0.length).toBe("31 March".length);
    }
  });

  test("text deletion → delete edit", () => {
    const rewrites: ParagraphRewrite[] = [
      {
        paragraphIndex: 4,
        newText:
          "The Receiving Party shall not disclose any Confidential Information to third parties.",
      },
    ];

    const { edits } = diffParagraphs(extracted, rewrites);

    expect(edits.length).toBe(1);
    const edit0 = edits[0];
    expect(edit0).toBeDefined();
    expect(edit0?.kind).toBe("delete");
    if (edit0?.kind === "delete") {
      expect(edit0.length).toBeGreaterThan(0);
    }
  });

  test("text insertion → insert edit", () => {
    const rewrites: ParagraphRewrite[] = [
      {
        paragraphIndex: 2,
        newText:
          "The Seller represents and warrants that the Shares are free from all encumbrances. The Seller further represents that no litigation is pending.",
      },
    ];

    const { edits } = diffParagraphs(extracted, rewrites);

    expect(edits.length).toBe(1);
    const edit0 = edits[0];
    expect(edit0).toBeDefined();
    expect(edit0?.kind).toBe("insert");
    if (edit0?.kind === "insert") {
      expect(edit0.text).toContain("no litigation");
    }
  });

  test("unchanged paragraph → no edits", () => {
    const rewrites: ParagraphRewrite[] = [
      {
        paragraphIndex: 0,
        newText:
          "The Purchase Price shall be one million Czech crowns (CZK 1,000,000).",
      },
    ];

    const { edits } = diffParagraphs(extracted, rewrites);
    expect(edits).toEqual([]);
  });

  test("nonexistent paragraph index → no edits", () => {
    const rewrites: ParagraphRewrite[] = [
      { paragraphIndex: 99, newText: "Ghost paragraph" },
    ];

    const { edits } = diffParagraphs(extracted, rewrites);
    expect(edits).toEqual([]);
  });

  test("multiple rewrites → edits for each paragraph", () => {
    const rewrites: ParagraphRewrite[] = [
      {
        paragraphIndex: 0,
        newText:
          "The Purchase Price shall be two million Czech crowns (CZK 2,000,000).",
      },
      {
        paragraphIndex: 1,
        newText: "The Closing Date shall be 30 June 2026.",
      },
    ];

    const { edits } = diffParagraphs(extracted, rewrites);

    const paraIndices = [...new Set(edits.map((e) => e.paragraphIndex))];
    expect(paraIndices).toContain(0);
    expect(paraIndices).toContain(1);
  });

  test("term change: two/2 → three/3", () => {
    const rewrites: ParagraphRewrite[] = [
      {
        paragraphIndex: 3,
        newText:
          "This Agreement shall remain in effect for a period of three (3) years from the Effective Date.",
      },
    ];

    const { edits } = diffParagraphs(extracted, rewrites);

    // Semantic cleanup merges "two (2" → "three (3" into
    // a single replace (the " (" equality is too short to keep)
    expect(edits.length).toBe(1);
    const edit0 = edits[0];
    expect(edit0).toBeDefined();
    expect(edit0?.kind).toBe("replace");
    if (edit0?.kind === "replace") {
      expect(edit0.text).toContain("three");
      expect(edit0.text).toContain("3");
    }
  });

  test("complete rewrite → tracked changes", () => {
    const rewrites: ParagraphRewrite[] = [
      {
        paragraphIndex: 2,
        newText:
          "The Seller makes no representations or warranties whatsoever.",
      },
    ];

    const { edits } = diffParagraphs(extracted, rewrites);

    expect(edits.length).toBeGreaterThan(0);
    const hasChanges = edits.some(
      (e) => e.kind === "replace" || e.kind === "delete",
    );
    expect(hasChanges).toBe(true);
  });
});

// ── Integration: diffParagraphs → applyEdits ──────────────

describe("diffParagraphs → applyEdits integration", () => {
  const WRAP = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body}</w:body></w:document>`;

  const P = (text: string) =>
    `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

  test("diff-generated edits produce valid tracked changes", () => {
    const xml = WRAP(
      P("The price is one million dollars.") + P("The date is 31 March 2026."),
    );
    const ext: ExtractedDocument = {
      paragraphs: [
        {
          index: 0,
          text: "The price is one million dollars.",
        },
        { index: 1, text: "The date is 31 March 2026." },
      ],
      charCount: 58,
      view: "accepted",
    };

    const rewrites: ParagraphRewrite[] = [
      {
        paragraphIndex: 0,
        newText: "The price is two million dollars.",
      },
      {
        paragraphIndex: 1,
        newText: "The date is 30 June 2026.",
      },
    ];

    const { edits } = diffParagraphs(ext, rewrites);
    const idGen = createIdGenerator(new Set());
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).toContain("w:del");
    expect(result).toContain("w:ins");
    // "one" deleted, "two" inserted
    expect(result).toContain("one");
    expect(result).toContain("two");
    // "31 March" deleted, "30 June" inserted
    expect(result).toContain("31 March");
    expect(result).toContain("30 June");
  });

  test("deletion produces valid tracked changes", () => {
    const xml = WRAP(
      P("The party shall not disclose information without prior consent."),
    );
    const ext: ExtractedDocument = {
      paragraphs: [
        {
          index: 0,
          text: "The party shall not disclose information without prior consent.",
        },
      ],
      charCount: 62,
      view: "accepted",
    };

    const rewrites: ParagraphRewrite[] = [
      {
        paragraphIndex: 0,
        newText: "The party shall not disclose information.",
      },
    ];

    const { edits } = diffParagraphs(ext, rewrites);
    const idGen = createIdGenerator(new Set());
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).toContain("w:del");
    expect(result).toContain("w:delText");
  });
});
