import { describe, expect, test } from "bun:test";

import type {
  Block,
  HeadingBlock,
  ParagraphBlock,
} from "@/api/handlers/case-law/document-ast";
import { validateAst } from "@/api/handlers/case-law/ingestion/parsers/validate-ast";

// ── Helpers ─────────────────────────────────────────────────

const makeBlock = (
  overrides: Partial<ParagraphBlock> & { plainText: string },
): ParagraphBlock => {
  const uid = crypto.randomUUID().slice(0, 8);
  return {
    id: `b-${uid}`,
    anchorId: `p-${uid}`,
    type: "paragraph",
    inlines: [{ type: "text", text: overrides.plainText }],
    ...overrides,
  };
};

const makeHeading = (text: string, level: 1 | 2 | 3 = 2): HeadingBlock => {
  const uid = crypto.randomUUID().slice(0, 8);
  return {
    id: `bh-${uid}`,
    anchorId: `h-${uid}`,
    type: "heading",
    level,
    role: "section-heading",
    inlines: [{ type: "text", text }],
    plainText: text,
  };
};

const wrapInHtml = (text: string): string =>
  `<html><body><p>${text}</p></body></html>`;

// ── Content completeness ────────────────────────────────────

describe("validateAst", () => {
  describe("content retention", () => {
    test("passes when AST retains all source text", () => {
      const text =
        "Soud konstatoval, že žaloba je důvodná " +
        "a žalobce má nárok na náhradu škody.";
      const html = wrapInHtml(text);
      const blocks: Block[] = [
        makeHeading("Odůvodnění:"),
        makeBlock({ plainText: text }),
      ];

      const result = validateAst(html, blocks);

      expect(result.ok).toBe(true);
      expect(result.stats.retainedPct).toBeGreaterThan(90);
    });

    test("flags content loss below threshold", () => {
      const fullText =
        "Okresní soud v Praze rozhodl dne 1. ledna 2025 " +
        "ve věci žalobce proti žalovanému o zaplacení " +
        "částky 100 000 Kč s příslušenstvím.";
      const html = wrapInHtml(fullText);
      // AST only has a fraction of the text
      const blocks: Block[] = [
        makeHeading("Odůvodnění:"),
        makeBlock({ plainText: "Okresní soud v Praze" }),
      ];

      const result = validateAst(html, blocks);

      expect(result.ok).toBe(false);
      const contentLoss = result.issues.find((i) => i.code === "CONTENT_LOSS");
      expect(contentLoss).toBeDefined();
      expect(contentLoss?.severity).toBe("error");
    });

    test("respects custom retention threshold", () => {
      // Source text is much longer than the AST text,
      // so retention is well below 100%.
      const longSource =
        "Soud konstatoval že žalobce podal řádnou žalobu " +
        "a žalovaný se k ní nevyjádřil ve stanovené lhůtě " +
        "přičemž soud provedl dokazování a zjistil " +
        "následující skutečnosti rozhodné pro věc";
      const html = wrapInHtml(longSource);
      const blocks: Block[] = [
        makeHeading("Heading"),
        makeBlock({ plainText: "Soud konstatoval" }),
      ];

      const strict = validateAst(html, blocks, {
        minRetainedPct: 99,
      });
      const lenient = validateAst(html, blocks, {
        minRetainedPct: 10,
        maxMissingWords: 100,
      });

      // Strict should flag; lenient should pass
      expect(strict.stats.retainedPct).toBeLessThan(99);
      expect(lenient.ok).toBe(true);
    });
  });

  // ── Missing words ──────────────────────────────────────────

  describe("missing words", () => {
    test("detects meaningful words missing from AST", () => {
      const words = Array.from(
        { length: 20 },
        (_, i) => `slovo${String.fromCodePoint(97 + i)}xx`,
      );
      const fullText = words.join(" ");
      const html = wrapInHtml(fullText);
      // AST only has the first 3 words
      const blocks: Block[] = [
        makeHeading("Heading"),
        makeBlock({ plainText: words.slice(0, 3).join(" ") }),
      ];

      const result = validateAst(html, blocks);

      expect(result.ok).toBe(false);
      const issue = result.issues.find((i) => i.code === "MISSING_WORDS");
      expect(issue).toBeDefined();
      expect(result.stats.missingWords.length).toBeGreaterThan(15);
    });

    test("skips short words and numbers", () => {
      const html = wrapInHtml("1 2 3 je to ok 42 99 ab");
      const blocks: Block[] = [
        makeHeading("H"),
        makeBlock({ plainText: "empty" }),
      ];

      const result = validateAst(html, blocks);

      // Short words and numbers should not be counted
      // as missing meaningful words
      expect(result.stats.missingWords).not.toContain("42");
      expect(result.stats.missingWords).not.toContain("ab");
    });

    test("skips decorative skip words", () => {
      const html = wrapInHtml("[OBRÁZEK] ČESKÁ republika jménem republiky");
      const blocks: Block[] = [
        makeHeading("H"),
        makeBlock({ plainText: "test" }),
      ];

      const result = validateAst(html, blocks);

      // Skip words should not appear in missing
      for (const w of ["česká", "republika", "jménem", "republiky"]) {
        expect(result.stats.missingWords).not.toContain(w);
      }
    });

    test("respects custom maxMissingWords threshold", () => {
      const words = Array.from(
        { length: 30 },
        (_, i) => `testword${String.fromCodePoint(97 + (i % 26))}${i}x`,
      );
      const html = wrapInHtml(words.join(" "));
      const blocks: Block[] = [
        makeHeading("H"),
        makeBlock({ plainText: words.slice(0, 5).join(" ") }),
      ];

      const strict = validateAst(html, blocks, {
        maxMissingWords: 5,
      });
      const lenient = validateAst(html, blocks, {
        maxMissingWords: 100,
      });

      expect(strict.issues.some((i) => i.code === "MISSING_WORDS")).toBe(true);
      expect(lenient.issues.some((i) => i.code === "MISSING_WORDS")).toBe(
        false,
      );
    });
  });

  // ── Structural checks ─────────────────────────────────────

  describe("structural checks", () => {
    test("flags empty AST", () => {
      const result = validateAst(wrapInHtml("text"), []);

      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === "EMPTY_AST")).toBe(true);
    });

    test("warns when no headings present", () => {
      const html = wrapInHtml("paragraph text");
      const blocks: Block[] = [makeBlock({ plainText: "paragraph text" })];

      const result = validateAst(html, blocks);

      expect(result.issues.some((i) => i.code === "NO_HEADINGS")).toBe(true);
    });

    test("no heading warning when headings exist", () => {
      const html = wrapInHtml("heading text body text");
      const blocks: Block[] = [
        makeHeading("heading text"),
        makeBlock({ plainText: "body text" }),
      ];

      const result = validateAst(html, blocks);

      expect(result.issues.some((i) => i.code === "NO_HEADINGS")).toBe(false);
    });
  });

  // ── Block-level anomalies ─────────────────────────────────

  describe("block anomalies", () => {
    test("counts tiny blocks (< 5 chars)", () => {
      const html = wrapInHtml("heading ab cd ef gh body text");
      const blocks: Block[] = [
        makeHeading("heading"),
        makeBlock({ plainText: "ab" }),
        makeBlock({ plainText: "cd" }),
        makeBlock({ plainText: "ef" }),
        makeBlock({ plainText: "gh" }),
        makeBlock({ plainText: "body text" }),
      ];

      const result = validateAst(html, blocks);

      expect(result.stats.tinyBlocks).toBe(4);
    });

    test("warns when too many tiny blocks", () => {
      const html = wrapInHtml("h a b c d");
      // More than 30% tiny
      const blocks: Block[] = [
        makeHeading("h"),
        makeBlock({ plainText: "a" }),
        makeBlock({ plainText: "b" }),
        makeBlock({ plainText: "c" }),
        makeBlock({ plainText: "d" }),
      ];

      const result = validateAst(html, blocks);

      expect(result.issues.some((i) => i.code === "TOO_MANY_TINY_BLOCKS")).toBe(
        true,
      );
    });

    test("detects huge blocks (> 5000 chars)", () => {
      const longText = "x".repeat(5001);
      const html = wrapInHtml(longText);
      const blocks: Block[] = [
        makeHeading("H"),
        makeBlock({ plainText: longText }),
      ];

      const result = validateAst(html, blocks);

      expect(result.stats.hugeBlocks).toBe(1);
      expect(result.issues.some((i) => i.code === "HUGE_BLOCKS")).toBe(true);
    });

    test("detects consecutive duplicate blocks", () => {
      const text = "Duplicated paragraph text here.";
      const html = wrapInHtml(`${text} ${text}`);
      const blocks: Block[] = [
        makeHeading("H"),
        makeBlock({ plainText: text }),
        makeBlock({ plainText: text }),
      ];

      const result = validateAst(html, blocks);

      expect(result.stats.duplicateBlocks).toBe(1);
      expect(result.issues.some((i) => i.code === "DUPLICATE_BLOCKS")).toBe(
        true,
      );
    });
  });

  // ── Inline-plainText consistency ──────────────────────────

  describe("inline-plainText consistency", () => {
    test("warns on significant mismatch", () => {
      const html = wrapInHtml("short text");
      const blocks: Block[] = [
        makeHeading("H"),
        {
          id: "b2",
          anchorId: "p-2",
          type: "paragraph",
          inlines: [{ type: "text", text: "this is much longer" }],
          plainText: "short",
        },
      ];

      const result = validateAst(html, blocks);

      expect(
        result.issues.some((i) => i.code === "INLINE_PLAINTEXT_MISMATCH"),
      ).toBe(true);
    });

    test("no mismatch warning for consistent blocks", () => {
      const text = "Soud rozhodl ve věci žalobce.";
      const html = wrapInHtml(text);
      const blocks: Block[] = [
        makeHeading("H"),
        makeBlock({ plainText: text }),
      ];

      const result = validateAst(html, blocks);

      expect(
        result.issues.some((i) => i.code === "INLINE_PLAINTEXT_MISMATCH"),
      ).toBe(false);
    });

    test("handles bold/italic inlines in length calc", () => {
      const text = "bold text here";
      const html = wrapInHtml(text);
      const blocks: Block[] = [
        makeHeading("H"),
        {
          id: "b2",
          anchorId: "p-2",
          type: "paragraph",
          inlines: [
            {
              type: "bold",
              children: [{ type: "text", text: "bold text here" }],
            },
          ],
          plainText: text,
        },
      ];

      const result = validateAst(html, blocks);

      expect(
        result.issues.some((i) => i.code === "INLINE_PLAINTEXT_MISMATCH"),
      ).toBe(false);
    });
  });

  // ── Stats output ──────────────────────────────────────────

  describe("stats", () => {
    test("reports block type distribution", () => {
      const html = wrapInHtml("h p1 closing v. r.");
      const blocks: Block[] = [
        makeHeading("h"),
        makeBlock({ plainText: "p1" }),
        makeBlock({ plainText: "closing", role: "closing" }),
        makeBlock({ plainText: "v. r.", role: "signature" }),
      ];

      const result = validateAst(html, blocks);

      expect(result.stats.blockTypeCounts.heading).toBe(1);
      expect(result.stats.blockTypeCounts["paragraph-closing"]).toBe(1);
      expect(result.stats.blockTypeCounts["paragraph-signature"]).toBe(1);
    });
  });
});
