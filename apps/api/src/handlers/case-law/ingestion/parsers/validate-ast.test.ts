import { describe, expect, test } from "bun:test";

import type {
  Block,
  HeadingBlock,
  ParagraphBlock,
} from "@/api/handlers/case-law/document-ast";
import {
  AST_CONTENT_LOST,
  AST_MISSING,
  AST_STRUCTURE_DEGRADED,
  DECISION_EMPTY,
  storedDecisionSignal,
  validateAst,
  validationSignal,
} from "@/api/lib/legal-search/parsers/validate-ast";

// ── Helpers ─────────────────────────────────────────────────

const makeBlock = (
  overrides: Partial<ParagraphBlock> & { plainText: string },
): ParagraphBlock => {
  const uid = Bun.randomUUIDv7().slice(0, 8);
  return {
    id: `b-${uid}`,
    anchorId: `p-${uid}`,
    type: "paragraph",
    inlines: [{ type: "text", text: overrides.plainText }],
    ...overrides,
  };
};

const makeHeading = (text: string, level: 1 | 2 | 3 = 2): HeadingBlock => {
  const uid = Bun.randomUUIDv7().slice(0, 8);
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

/**
 * A source that publishes no decision text, in the shape courts actually
 * serve it: the document endpoint answers with a placeholder in the body
 * rather than an error, so the fetch succeeds and the parser is handed a
 * page with nothing to parse.
 */
const TEXTLESS_SOURCE =
  `<!DOCTYPE html><html lang="cs"><head><title>39 A 1/2026-35 - text` +
  `</title></head><body>N/A</body></html>`;

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

    test("treats a decorative marker as a word boundary, not glue", () => {
      // Real NSS pattern: image placeholders run flush against the
      // heading text and against each other, with no whitespace
      // between them. The space-separated form above cannot reach this
      // path, because splitting on whitespace already separates it.
      const html = wrapInHtml(
        "[OBRÁZEK]ČESKÁ REPUBLIKA [OBRÁZEK][OBRÁZEK] rozsudek",
      );
      const blocks: Block[] = [
        makeHeading("H"),
        makeBlock({ plainText: "rozsudek" }),
      ];

      const result = validateAst(html, blocks);

      expect(result.stats.missingWords).toEqual([]);
    });

    test("treats a bracketless decorative marker as a boundary, not glue", () => {
      // NSS also serves the emblem placeholder without brackets, flush
      // against the following word ("OBRÁZEKČeská", "OBRÁZEKaplikační").
      // cheerio's .text() concatenates it with no space, so the fused
      // token reaches the word set with no bracket for the marker split
      // to act on. The AST is right to drop the decoration, so the
      // remainder ("česká", "aplikační") must not read as missing.
      const html = wrapInHtml(
        "OBRÁZEKČeská republika rozsudek jménem republiky " +
          "OBRÁZEKaplikační doložka OBRÁZEKpro úplnost",
      );
      const blocks: Block[] = [
        makeHeading("H"),
        makeBlock({
          plainText:
            "Česká republika rozsudek jménem republiky " +
            "aplikační doložka pro úplnost",
        }),
      ];

      const result = validateAst(html, blocks);

      expect(result.stats.missingWords).toEqual([]);
    });

    test("treats an inline-element marker boundary as glue, not loss", () => {
      // The same placeholder wrapped in an inline element
      // ("<span>Obrázek</span>Česká") glues the same way: .text()
      // joins the span's text to the next node with no space.
      const html = wrapInHtml(
        "<span>Obrázek</span>Česká republika rozsudek jménem republiky " +
          "<span>Obrázek</span>aplikační doložka",
      );
      const blocks: Block[] = [
        makeHeading("H"),
        makeBlock({
          plainText:
            "Česká republika rozsudek jménem republiky aplikační doložka",
        }),
      ];

      const result = validateAst(html, blocks);

      expect(result.stats.missingWords).toEqual([]);
    });

    test("still reports a real word lost behind a decorative marker", () => {
      // Peeling the marker must not swallow genuine loss: the remainder
      // is absent from the AST, so it stays missing.
      const html = wrapInHtml(
        "OBRÁZEKžaloba byla podána včas a je důvodná podle soudu",
      );
      const blocks: Block[] = [
        makeHeading("H"),
        makeBlock({ plainText: "byla podána včas a je důvodná podle soudu" }),
      ];

      const result = validateAst(html, blocks);

      // The genuinely absent word still surfaces (as the fused token,
      // since its peeled remainder resolves to neither the AST nor a
      // skip word): peeling clears phantoms, it does not hide loss.
      expect(result.stats.missingWords.some((w) => w.includes("žaloba"))).toBe(
        true,
      );
    });

    test("keeps a mid-word anonymization marker joined", () => {
      // "[o]rganizace" anonymizes one letter inside a word: the
      // brackets are removed, not treated as a boundary, or the
      // remainder ("rganizace") becomes a phantom missing word. The
      // leading decorative marker puts both kinds of group in one
      // token, so only the skippable one may become a boundary.
      const html = wrapInHtml("[OBRÁZEK][o]rganizace podala kasační stížnost");
      const blocks: Block[] = [
        makeHeading("H"),
        makeBlock({ plainText: "podala kasační stížnost" }),
      ];

      const result = validateAst(html, blocks);

      expect(result.stats.missingWords).toContain("organizace");
      expect(result.stats.missingWords).not.toContain("rganizace");
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

    test("treats <br> as a word boundary, not glue", () => {
      // Real SAOS pattern: single-letter Polish prepositions wrapped
      // to the next line via <br/>. The reference extraction must not
      // fuse them into phantom words ("wrazz") absent from the AST.
      const html =
        "<html><body><p>kosztów zastępstwa wraz<br/>z " +
        "ustawowymi odsetkami należnymi powodowi</p></body></html>";
      const blocks: Block[] = [
        makeHeading("Uzasadnienie"),
        makeBlock({
          plainText:
            "kosztów zastępstwa wraz\nz ustawowymi odsetkami " +
            "należnymi powodowi",
        }),
      ];

      const result = validateAst(html, blocks);

      expect(result.stats.missingWords).toEqual([]);
      expect(result.ok).toBe(true);
    });

    test("keeps Polish diacritics at word edges", () => {
      const words = Array.from(
        { length: 20 },
        (_, i) => `źdźbło${String.fromCodePoint(97 + i)}ż`,
      );
      const html = wrapInHtml(`${words.join(" ")} mógł Łódź`);
      const blocks: Block[] = [
        makeHeading("H"),
        makeBlock({ plainText: "brak" }),
      ];

      const result = validateAst(html, blocks);

      // Edge diacritics must survive word extraction; the untrimmed
      // words are reported missing (not "dźbło..." fragments).
      expect(result.stats.missingWords).toContain("źdźbłoaż");
      // ł is the most common edge diacritic in Polish (past-tense verbs,
      // proper names); trimming it would shrink "mógł" below the 3-char
      // cutoff and hide it entirely.
      expect(result.stats.missingWords).toContain("mógł");
      expect(result.stats.missingWords).toContain("łódź");
    });
  });

  // ── Structural checks ─────────────────────────────────────

  describe("structural checks", () => {
    test("flags empty AST", () => {
      const result = validateAst(wrapInHtml("text"), []);

      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === "EMPTY_AST")).toBe(true);
    });

    test("empty AST over a text-less source is not content loss", () => {
      const result = validateAst(TEXTLESS_SOURCE, []);

      // The fixture has to reach the text-less branch for the rest to
      // mean anything: bare body text sits outside the content selector,
      // so nothing is extracted and there is nothing an AST could drop.
      expect(result.stats.originalLength).toBe(0);
      expect(result.stats.retainedPct).toBe(100);

      expect(result.issues.some((i) => i.code === "EMPTY_AST")).toBe(true);
      expect(result.ok).toBe(true);
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

    test("ignores whitespace-only differences from normalization", () => {
      // Parsers collapse whitespace in plainText but keep the source
      // spacing inside inlines; that alone is not a mismatch.
      const text = "Sąd Okręgowy zważył, co następuje:";
      const html = wrapInHtml(text);
      const blocks: Block[] = [
        makeHeading("H"),
        {
          id: "b2",
          anchorId: "p-2",
          type: "paragraph",
          inlines: [
            { type: "text", text: "   Sąd  Okręgowy   zważył, " },
            { type: "line-break" },
            { type: "text", text: " co następuje:   " },
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

      expect(result.stats.blockTypeCounts["heading"]).toBe(1);
      expect(result.stats.blockTypeCounts["paragraph-closing"]).toBe(1);
      expect(result.stats.blockTypeCounts["paragraph-signature"]).toBe(1);
    });
  });
});

// ── Parse signal ────────────────────────────────────────────

describe("storedDecisionSignal", () => {
  test("a decision with neither text nor AST is an error", () => {
    // The state sk-courts has been storing since PDF fetching was
    // deferred: nothing about the decision is readable, and no parser
    // ran to report it.
    expect(storedDecisionSignal({ hasFulltext: false, astBlocks: 0 })).toEqual({
      event: DECISION_EMPTY,
      level: "error",
    });
  });

  test("text without structure is a warning, not an error", () => {
    // The wall-of-text state: degraded, but the decision is readable
    // and citable, so it must not compete with real loss for attention.
    expect(storedDecisionSignal({ hasFulltext: true, astBlocks: 0 })).toEqual({
      event: AST_MISSING,
      level: "warn",
    });
  });

  test("a parsed decision reports nothing", () => {
    expect(
      storedDecisionSignal({ hasFulltext: true, astBlocks: 12 }),
    ).toBeUndefined();
  });
});

describe("validationSignal", () => {
  const signalFor = (html: string, blocks: Block[]) =>
    validationSignal(validateAst(html, blocks));

  const body = (text: string) => `<html><body><p>${text}</p></body></html>`;
  const LONG =
    "Alpha bravo charlie delta echo foxtrot golf hotel india juliet " +
    "kilo lima mike november oscar papa quebec romeo sierra tango";

  test("source text missing from the AST is an error", () => {
    expect(signalFor(body(LONG), [])).toEqual({
      event: AST_CONTENT_LOST,
      level: "error",
    });
  });

  test("a complete AST with imperfect structure is a warning", () => {
    // Headingless, but every word survived: readable and citable, so
    // it must not compete with real loss for attention.
    const text = "Alpha bravo charlie delta echo foxtrot golf hotel india.";
    expect(signalFor(body(text), [makeBlock({ plainText: text })])).toEqual({
      event: AST_STRUCTURE_DEGRADED,
      level: "warn",
    });
  });

  test("a text-less source parsed to nothing is a warning", () => {
    // Both signals fire on the same document otherwise: the pipeline
    // already reports the emptiness as `decision_empty`, so reporting it
    // again as loss would put a parser defect on an operator's sweep for
    // a document the parser handled correctly.
    expect(signalFor(TEXTLESS_SOURCE, [])).toEqual({
      event: AST_STRUCTURE_DEGRADED,
      level: "warn",
    });
  });

  test("a clean parse reports nothing", () => {
    const text = "Alpha bravo charlie delta echo foxtrot golf hotel india.";
    expect(
      signalFor(body(text), [
        makeHeading("Judgment"),
        makeBlock({ plainText: text }),
      ]),
    ).toBeUndefined();
  });
});

/**
 * The ancestor-dedup must not re-stringify whole subtrees per content
 * element — that is quadratic on flat many-paragraph documents. The bound
 * is deliberately loose: memoized, this document validates in well under a
 * second, while the quadratic form costs minutes at this size. Anything in
 * between is machine noise, so a wide bound separates the two behaviours
 * without flaking when the suite runs in parallel.
 */
describe("validateAst scaling", () => {
  test("a flat many-paragraph document validates in linear-ish time", () => {
    const count = 6000;
    const paragraphs = Array.from(
      { length: count },
      (_, index) => `<p>Paragraf ${index} sądu okręgowego w sprawie.</p>`,
    ).join("\n");
    const html = `<html><body><div>${paragraphs}</div></body></html>`;
    const blocks: Block[] = Array.from({ length: count }, (_, index) => ({
      id: `p${index}`,
      anchorId: `p${index}`,
      type: "paragraph",
      inlines: [],
      plainText: `Paragraf ${index} sądu okręgowego w sprawie.`,
    }));

    const start = performance.now();
    const result = validateAst(html, blocks);
    const elapsed = performance.now() - start;

    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual(
      [],
    );
    expect(elapsed).toBeLessThan(20_000);
  });
});
