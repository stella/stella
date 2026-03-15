/**
 * Property-based and snapshot tests for the DOCX editing pipeline.
 *
 * Property-based tests (fast-check) verify invariants that must
 * hold for ALL inputs, not just hand-picked examples:
 *
 * - Roundtrip: diff(old, new) → apply(old, edits) → extract
 *   should produce text matching `new`
 * - ID uniqueness: generated IDs never collide
 * - Run map coverage: offsets cover full paragraph text
 *
 * Snapshot tests lock down the exact XML structure of tracked
 * changes so regressions are caught immediately.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import JSZip from "jszip";
import * as slimdom from "slimdom";

import { applyEdits } from "./apply-edits";
import { diffParagraphs, tokenize } from "./diff-paragraphs";
import { discoverPlaceholders } from "./discover-placeholders";
import { createIdGenerator, W_NS } from "./ooxml";
import { buildRunMap } from "./run-map";
import type { RevisionAuthor } from "./types";
import { collectAllIds, validateOoxml } from "./validate-ooxml";

const AUTHOR: RevisionAuthor = {
  name: "Stella AI",
  date: "2026-02-17T12:00:00Z",
};

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="${W_NS}">` +
  `<w:body>${body}</w:body></w:document>`;

const P = (text: string) =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

// ── Helpers ──────────────────────────────────────────────

/** Extract "accepted" text from a paragraph in edited XML. */
const extractAcceptedText = (xml: string): string[] => {
  const doc = slimdom.parseXmlDocument(xml);
  const body = doc.getElementsByTagNameNS(W_NS, "body").at(0);
  if (!body) {
    return [];
  }

  const texts: string[] = [];
  for (const child of body.childNodes) {
    if (child.nodeType !== child.ELEMENT_NODE) {
      continue;
    }
    // SAFETY: ELEMENT_NODE implies Element in slimdom
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const el = child as slimdom.Element;
    if (el.localName !== "p" || el.namespaceURI !== W_NS) {
      continue;
    }

    let text = "";
    const walk = (node: slimdom.Node) => {
      if (node.nodeType !== node.ELEMENT_NODE) {
        return;
      }
      // SAFETY: ELEMENT_NODE implies Element in slimdom
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const n = node as slimdom.Element;
      // Skip deleted content
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

// ── Arbitraries ──────────────────────────────────────────

/** Strip chars illegal in XML 1.0 text; normalize line endings. */
const sanitizeForXml = (s: string): string =>
  s
    .replace(/[<>&"']/g, "")
    // eslint-disable-next-line no-control-regex -- strip XML-illegal control chars
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    // Lone surrogates and non-characters are forbidden in XML 1.0.
    // fast-check unit:"binary" produces raw UTF-16 code units which
    // can include these.
    .replace(/[\uD800-\uDFFF\uFFFE\uFFFF]/g, "")
    // XML parsers normalize \r\n → \n and lone \r → \n.
    // Reflect this so test data matches parsed output.
    .replace(/\r\n?/g, "\n")
    .trim();

/** Any Unicode string safe for XML text nodes. */
const xmlSafeWord = fc
  .string({ minLength: 1, maxLength: 20, unit: "grapheme" })
  .map(sanitizeForXml)
  .filter((s) => s.length > 0);

/** Unicode word (letters from any script, 1-12 chars). */
const NON_LETTER_RE = /[^\p{L}]/gu;
const word = fc
  .string({ minLength: 2, maxLength: 16, unit: "grapheme" })
  .map((s) => s.replace(NON_LETTER_RE, ""))
  .filter((s) => s.length > 0);

/** Generate a sentence of 2-8 words. */
const sentence = fc
  .array(word, { minLength: 2, maxLength: 8 })
  .map((words) => words.join(" "));

// ── Adversarial arbitraries ──────────────────────────────

/**
 * Legal citation fragments: sections, subsections,
 * parenthetical refs. Exercises the tokenizer's non-word
 * boundary handling.
 */
const legalFragment = fc.constantFrom(
  "§ 1234",
  "(a)(1)(A)",
  "Art. 5(2)",
  "Abs. 3 S. 1",
  "č. 40/1964 Zb.",
  "§§ 823, 831 BGB",
  "sub-section 12.3.4",
  "¶¶ 15–18",
);

/** Text with mixed punctuation and whitespace. */
const punctuatedText = fc
  .array(
    fc.oneof(
      word,
      legalFragment,
      fc.constantFrom(": ", "; ", ", ", ". ", " — ", " / "),
    ),
    { minLength: 3, maxLength: 10 },
  )
  .map((parts) => parts.join(""))
  .map(sanitizeForXml)
  .filter((s) => s.length > 0);

/** Text with varied whitespace (tabs, double spaces). */
const whitespaceText = fc
  .array(word, { minLength: 3, maxLength: 8 })
  .chain((words) =>
    fc
      .array(fc.constantFrom(" ", "  ", "\t", " \t "), {
        minLength: words.length - 1,
        maxLength: words.length - 1,
      })
      .map((separators) =>
        words
          .map((w, i) => (i < separators.length ? w + separators[i] : w))
          .join(""),
      ),
  );

/** Long paragraph (50-200 words). */
const longParagraph = fc
  .array(word, { minLength: 50, maxLength: 200 })
  .map((words) => words.join(" "));

/**
 * CJK-heavy text: each character is a separate token
 * since \p{L} matches individual CJK ideographs.
 */

const CJK_CHARS = Array.from("契約条項法律裁判所判決証拠原告被告弁護士");
const cjkText = fc
  .array(fc.constantFrom(...CJK_CHARS), {
    minLength: 3,
    maxLength: 15,
  })
  .map((chars) => chars.join(""));

/** Same word repeated, forcing diff alignment decisions. */
const repeatedText = fc
  .tuple(word, fc.integer({ min: 3, max: 8 }))
  .map(([w, n]) => Array.from({ length: n }, () => w).join(" "));

// ── Property: diff → apply roundtrip ─────────────────────

describe("property: diff → apply roundtrip", () => {
  test("rewriting a paragraph preserves the new text", async () => {
    fc.assert(
      fc.property(sentence, sentence, (oldText, newText) => {
        // Skip trivially equal inputs
        if (oldText === newText) {
          return;
        }

        const xml = WRAP(P(oldText));
        const extracted = {
          paragraphs: [{ index: 0, text: oldText }],
          charCount: oldText.length,
          view: "accepted" as const,
        };

        const { edits } = diffParagraphs(extracted, [
          { paragraphIndex: 0, newText },
        ]);

        const idGen = createIdGenerator(new Set());
        const result = applyEdits(xml, edits, AUTHOR, idGen);

        const accepted = extractAcceptedText(result);
        expect(accepted[0]).toBe(newText);
      }),
      { numRuns: 200 },
    );
  });

  test("unchanged text produces no edits", async () => {
    fc.assert(
      fc.property(sentence, (text) => {
        const extracted = {
          paragraphs: [{ index: 0, text }],
          charCount: text.length,
          view: "accepted" as const,
        };

        const { edits } = diffParagraphs(extracted, [
          { paragraphIndex: 0, newText: text },
        ]);

        expect(edits).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  test("deletion produces shorter accepted text", async () => {
    fc.assert(
      fc.property(
        sentence.filter((s) => s.length > 5),
        (text) => {
          // Delete last word
          const words = text.split(" ");
          if (words.length < 2) {
            return;
          }
          const shortened = words.slice(0, -1).join(" ");

          const xml = WRAP(P(text));
          const extracted = {
            paragraphs: [{ index: 0, text }],
            charCount: text.length,
            view: "accepted" as const,
          };

          const { edits } = diffParagraphs(extracted, [
            { paragraphIndex: 0, newText: shortened },
          ]);

          const idGen = createIdGenerator(new Set());
          const result = applyEdits(xml, edits, AUTHOR, idGen);

          // Accepted text should match the shortened version
          const accepted = extractAcceptedText(result);
          expect(accepted[0]).toBe(shortened);

          // XML should contain w:del markup
          expect(result).toContain("w:del");
        },
      ),
      { numRuns: 100 },
    );
  });

  test("insertion produces longer accepted text", async () => {
    fc.assert(
      fc.property(sentence, sentence, (text, extra) => {
        const extended = `${text} ${extra}`;
        const xml = WRAP(P(text));
        const extracted = {
          paragraphs: [{ index: 0, text }],
          charCount: text.length,
          view: "accepted" as const,
        };

        const { edits } = diffParagraphs(extracted, [
          { paragraphIndex: 0, newText: extended },
        ]);

        const idGen = createIdGenerator(new Set());
        const result = applyEdits(xml, edits, AUTHOR, idGen);

        const accepted = extractAcceptedText(result);
        expect(accepted[0]).toBe(extended);
        expect(result).toContain("w:ins");
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property: multi-paragraph roundtrip ──────────────────

describe("property: multi-paragraph editing", () => {
  test("editing one paragraph doesn't affect others", async () => {
    fc.assert(
      fc.property(sentence, sentence, sentence, (text1, text2, newText2) => {
        if (text2 === newText2) {
          return;
        }

        const xml = WRAP(P(text1) + P(text2));
        const extracted = {
          paragraphs: [
            { index: 0, text: text1 },
            { index: 1, text: text2 },
          ],
          charCount: text1.length + text2.length,
          view: "accepted" as const,
        };

        const { edits } = diffParagraphs(extracted, [
          { paragraphIndex: 1, newText: newText2 },
        ]);

        const idGen = createIdGenerator(new Set());
        const result = applyEdits(xml, edits, AUTHOR, idGen);

        const accepted = extractAcceptedText(result);
        // First paragraph untouched
        expect(accepted[0]).toBe(text1);
        // Second paragraph changed
        expect(accepted[1]).toBe(newText2);
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property: ID generation ──────────────────────────────

describe("property: ID generation", () => {
  test("generated IDs never collide with existing", async () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat({ max: 10_000 }), {
          minLength: 0,
          maxLength: 50,
        }),
        fc.nat({ max: 20 }),
        (existingArray, count) => {
          const existing = new Set(existingArray);
          const originalIds = new Set(existing);
          const gen = createIdGenerator(existing);

          for (let i = 0; i < count; i++) {
            const id = gen();
            expect(originalIds.has(id)).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test("generated IDs are always unique", async () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat({ max: 10_000 }), {
          minLength: 0,
          maxLength: 20,
        }),
        fc.integer({ min: 2, max: 50 }),
        (existingArray, count) => {
          const gen = createIdGenerator(new Set(existingArray));
          const generated = new Set<number>();

          for (let i = 0; i < count; i++) {
            const id = gen();
            expect(generated.has(id)).toBe(false);
            generated.add(id);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ── Property: run map coverage ───────────────────────────

describe("property: run map coverage", () => {
  test("offsets are contiguous and cover full text", async () => {
    fc.assert(
      fc.property(xmlSafeWord, (text) => {
        const xml = WRAP(P(text));
        const doc = slimdom.parseXmlDocument(xml);
        const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
        if (!body) {
          throw new Error("No w:body");
        }
        const pEl = body.getElementsByTagNameNS(W_NS, "p")[0];
        if (!pEl) {
          throw new Error("No w:p");
        }

        const spans = buildRunMap(pEl);

        if (text.length === 0) {
          expect(spans).toEqual([]);
          return;
        }

        // Should have at least one span
        expect(spans.length).toBeGreaterThan(0);

        // First span starts at 0
        expect(spans[0]?.start).toBe(0);

        // Spans are contiguous
        for (let i = 1; i < spans.length; i++) {
          const cur = spans[i];
          const prev = spans[i - 1];
          if (!cur || !prev) {
            continue;
          }
          expect(cur.start).toBe(prev.start + prev.length);
        }

        // Total length matches text (length > 0 asserted above)
        const totalLen = spans.reduce((sum, s) => sum + s.length, 0);
        expect(totalLen).toBe(text.length);
      }),
      { numRuns: 200 },
    );
  });
});

// ── Snapshot: XML structure ──────────────────────────────

describe("snapshot: tracked change XML structure", () => {
  test("simple replace produces expected XML", () => {
    const xml = WRAP(P("Hello world"));
    const { edits } = diffParagraphs(
      {
        paragraphs: [{ index: 0, text: "Hello world" }],
        charCount: 11,
        view: "accepted",
      },
      [{ paragraphIndex: 0, newText: "Hello earth" }],
    );

    const idGen = createIdGenerator(new Set());
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).toMatchSnapshot();
  });

  test("delete produces expected XML", () => {
    const xml = WRAP(P("Remove this extra word please"));
    const { edits } = diffParagraphs(
      {
        paragraphs: [
          {
            index: 0,
            text: "Remove this extra word please",
          },
        ],
        charCount: 29,
        view: "accepted",
      },
      [
        {
          paragraphIndex: 0,
          newText: "Remove this word please",
        },
      ],
    );

    const idGen = createIdGenerator(new Set());
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).toMatchSnapshot();
  });

  test("insert produces expected XML", () => {
    const xml = WRAP(P("The contract is valid"));
    const { edits } = diffParagraphs(
      {
        paragraphs: [{ index: 0, text: "The contract is valid" }],
        charCount: 21,
        view: "accepted",
      },
      [
        {
          paragraphIndex: 0,
          newText: "The contract is valid and enforceable",
        },
      ],
    );

    const idGen = createIdGenerator(new Set());
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).toMatchSnapshot();
  });

  test("multi-edit produces expected XML", () => {
    const xml = WRAP(
      P("The price is one million dollars") + P("The date is 31 March 2026"),
    );
    const { edits } = diffParagraphs(
      {
        paragraphs: [
          {
            index: 0,
            text: "The price is one million dollars",
          },
          {
            index: 1,
            text: "The date is 31 March 2026",
          },
        ],
        charCount: 56,
        view: "accepted",
      },
      [
        {
          paragraphIndex: 0,
          newText: "The price is two million dollars",
        },
        {
          paragraphIndex: 1,
          newText: "The date is 30 June 2026",
        },
      ],
    );

    const idGen = createIdGenerator(new Set());
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).toMatchSnapshot();
  });
});

// ── Property: tokenization roundtrip ─────────────────────

describe("property: tokenization roundtrip", () => {
  test("tokenize(text).join('') === text for any Unicode", async () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 80, unit: "grapheme" }),
        (text) => {
          expect(tokenize(text).join("")).toBe(text);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ── Property: output w:id uniqueness ─────────────────────

describe("property: output w:id uniqueness", () => {
  test("all w:id values are unique after editing", async () => {
    fc.assert(
      fc.property(sentence, sentence, (oldText, newText) => {
        if (oldText === newText) {
          return;
        }

        const xml = WRAP(P(oldText));
        const extracted = {
          paragraphs: [{ index: 0, text: oldText }],
          charCount: oldText.length,
          view: "accepted" as const,
        };

        const { edits } = diffParagraphs(extracted, [
          { paragraphIndex: 0, newText },
        ]);

        const idGen = createIdGenerator(new Set());
        const result = applyEdits(xml, edits, AUTHOR, idGen);

        const doc = slimdom.parseXmlDocument(result);
        const ids = collectAllIds(doc);
        expect(ids.length).toBe(new Set(ids).size);
      }),
      { numRuns: 200 },
    );
  });
});

// ── Property: multi-w:t per run ──────────────────────────

describe("property: multi-w:t per run", () => {
  test("replacing text that spans two w:t elements doesn't crash", async () => {
    fc.assert(
      fc.property(
        xmlSafeWord,
        xmlSafeWord,
        sentence,
        (textA, textB, replacement) => {
          // Build XML with a single w:r containing two w:t nodes
          const multiT =
            "<w:p><w:r>" +
            `<w:t xml:space="preserve">${textA}</w:t>` +
            `<w:t xml:space="preserve">${textB}</w:t>` +
            "</w:r></w:p>";
          const xml = WRAP(multiT);
          const combined = textA + textB;

          if (combined.length === 0 || combined === replacement) {
            return;
          }

          // Replace the entire combined text (spans both w:t nodes)
          const extracted = {
            paragraphs: [{ index: 0, text: combined }],
            charCount: combined.length,
            view: "accepted" as const,
          };

          const { edits } = diffParagraphs(extracted, [
            { paragraphIndex: 0, newText: replacement },
          ]);

          const idGen = createIdGenerator(new Set());
          // Should not throw (would have caught bug #3)
          const result = applyEdits(xml, edits, AUTHOR, idGen);
          const accepted = extractAcceptedText(result);
          expect(accepted[0]).toBe(replacement);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("deleting trailing w:t preserves leading w:t text", async () => {
    fc.assert(
      fc.property(xmlSafeWord, xmlSafeWord, (textA, textB) => {
        const multiT =
          "<w:p><w:r>" +
          `<w:t xml:space="preserve">${textA}</w:t>` +
          `<w:t xml:space="preserve">${textB}</w:t>` +
          "</w:r></w:p>";
        const xml = WRAP(multiT);
        const combined = textA + textB;

        if (combined === textA) {
          return;
        }

        // Keep only the first w:t's text, effectively
        // deleting the second
        const extracted = {
          paragraphs: [{ index: 0, text: combined }],
          charCount: combined.length,
          view: "accepted" as const,
        };

        const { edits } = diffParagraphs(extracted, [
          { paragraphIndex: 0, newText: textA },
        ]);

        const idGen = createIdGenerator(new Set());
        const result = applyEdits(xml, edits, AUTHOR, idGen);
        const accepted = extractAcceptedText(result);
        expect(accepted[0]).toBe(textA);
      }),
      { numRuns: 100 },
    );
  });

  test("deleting leading w:t preserves trailing w:t text", async () => {
    fc.assert(
      fc.property(xmlSafeWord, xmlSafeWord, (textA, textB) => {
        const multiT =
          "<w:p><w:r>" +
          `<w:t xml:space="preserve">${textA}</w:t>` +
          `<w:t xml:space="preserve">${textB}</w:t>` +
          "</w:r></w:p>";
        const xml = WRAP(multiT);
        const combined = textA + textB;

        if (combined === textB) {
          return;
        }

        // Keep only the second w:t's text, effectively
        // deleting the first
        const extracted = {
          paragraphs: [{ index: 0, text: combined }],
          charCount: combined.length,
          view: "accepted" as const,
        };

        const { edits } = diffParagraphs(extracted, [
          { paragraphIndex: 0, newText: textB },
        ]);

        const idGen = createIdGenerator(new Set());
        const result = applyEdits(xml, edits, AUTHOR, idGen);
        const accepted = extractAcceptedText(result);
        expect(accepted[0]).toBe(textB);
      }),
      { numRuns: 100 },
    );
  });

  test("three w:t nodes, editing middle preserves siblings", async () => {
    fc.assert(
      fc.property(
        xmlSafeWord,
        xmlSafeWord,
        xmlSafeWord,
        sentence,
        (textA, textB, textC, replacement) => {
          const multiT =
            "<w:p><w:r>" +
            `<w:t xml:space="preserve">${textA}</w:t>` +
            `<w:t xml:space="preserve">${textB}</w:t>` +
            `<w:t xml:space="preserve">${textC}</w:t>` +
            "</w:r></w:p>";
          const xml = WRAP(multiT);
          const combined = textA + textB + textC;

          if (combined.length === 0 || combined === replacement) {
            return;
          }

          const extracted = {
            paragraphs: [{ index: 0, text: combined }],
            charCount: combined.length,
            view: "accepted" as const,
          };

          const { edits } = diffParagraphs(extracted, [
            { paragraphIndex: 0, newText: replacement },
          ]);

          const idGen = createIdGenerator(new Set());
          const result = applyEdits(xml, edits, AUTHOR, idGen);
          const accepted = extractAcceptedText(result);
          expect(accepted[0]).toBe(replacement);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("multi-w:t output passes OOXML validation", async () => {
    fc.assert(
      fc.property(
        xmlSafeWord,
        xmlSafeWord,
        sentence,
        (textA, textB, replacement) => {
          const multiT =
            "<w:p><w:r>" +
            `<w:t xml:space="preserve">${textA}</w:t>` +
            `<w:t xml:space="preserve">${textB}</w:t>` +
            "</w:r></w:p>";
          const xml = WRAP(multiT);
          const combined = textA + textB;

          if (combined.length === 0 || combined === replacement) {
            return;
          }

          const extracted = {
            paragraphs: [{ index: 0, text: combined }],
            charCount: combined.length,
            view: "accepted" as const,
          };

          const { edits } = diffParagraphs(extracted, [
            { paragraphIndex: 0, newText: replacement },
          ]);

          const idGen = createIdGenerator(new Set());
          const result = applyEdits(xml, edits, AUTHOR, idGen);

          const validation = validateOoxml(result);
          if (!validation.valid) {
            expect(validation.violations).toEqual([]);
          }
          expect(validation.valid).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property: OOXML validation passes on all output ──────

describe("property: OOXML validation on generated output", () => {
  test("applyEdits output passes validation", async () => {
    fc.assert(
      fc.property(sentence, sentence, (oldText, newText) => {
        if (oldText === newText) {
          return;
        }

        const xml = WRAP(P(oldText));
        const extracted = {
          paragraphs: [{ index: 0, text: oldText }],
          charCount: oldText.length,
          view: "accepted" as const,
        };

        const { edits } = diffParagraphs(extracted, [
          { paragraphIndex: 0, newText },
        ]);

        const idGen = createIdGenerator(new Set());
        const result = applyEdits(xml, edits, AUTHOR, idGen);

        const validation = validateOoxml(result);
        if (!validation.valid) {
          // Provide detail on failure
          expect(validation.violations).toEqual([]);
        }
        expect(validation.valid).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  test("multi-paragraph edits pass validation", async () => {
    fc.assert(
      fc.property(
        sentence,
        sentence,
        sentence,
        sentence,
        (text1, text2, new1, new2) => {
          if (text1 === new1 && text2 === new2) {
            return;
          }

          const xml = WRAP(P(text1) + P(text2));
          const extracted = {
            paragraphs: [
              { index: 0, text: text1 },
              { index: 1, text: text2 },
            ],
            charCount: text1.length + text2.length,
            view: "accepted" as const,
          };

          const rewrites: { paragraphIndex: number; newText: string }[] = [];
          if (text1 !== new1) {
            rewrites.push({ paragraphIndex: 0, newText: new1 });
          }
          if (text2 !== new2) {
            rewrites.push({ paragraphIndex: 1, newText: new2 });
          }

          const { edits } = diffParagraphs(extracted, rewrites);
          const idGen = createIdGenerator(new Set());
          const result = applyEdits(xml, edits, AUTHOR, idGen);

          const validation = validateOoxml(result);
          if (!validation.valid) {
            expect(validation.violations).toEqual([]);
          }
          expect(validation.valid).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property: placeholder roundtrip ──────────────────────

/** Build a minimal DOCX buffer with the given paragraph XML. */
const buildDocxBuffer = async (bodyXml: string): Promise<Buffer> => {
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="${W_NS}">` +
    `<w:body>${bodyXml}</w:body></w:document>`;

  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

/**
 * Placeholder name from realistic scripts (Latin, Czech,
 * Cyrillic, CJK). Avoids XML-incompatible compatibility
 * ideographs that don't roundtrip through XML parsers.
 */
const PLACEHOLDER_CHARS = Array.from(
  "abcdefghijklmnopqrstuvwxyz" +
    "áéíóúčřšžňďťůý" +
    "бвгдежзиклмнопрстуфхцчшщ" +
    "名前住所日付" +
    "0123456789_",
);
const placeholderName = fc
  .array(fc.constantFrom(...PLACEHOLDER_CHARS), {
    minLength: 1,
    maxLength: 12,
  })
  .map((chars) => chars.join(""));

describe("property: placeholder roundtrip", () => {
  test("discoverPlaceholders finds all Unicode-named tags", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(placeholderName, {
          minLength: 1,
          maxLength: 6,
          comparator: (a, b) => a === b,
        }),
        async (names) => {
          // Build a paragraph containing each placeholder
          const bodyXml = names
            .map(
              (name) =>
                `<w:p><w:r><w:t xml:space="preserve">` +
                `Value: {{${name}}}</w:t></w:r></w:p>`,
            )
            .join("");

          const buffer = await buildDocxBuffer(bodyXml);
          const discovered = await discoverPlaceholders(buffer);
          const discoveredNames = discovered.map((p) => p.name);

          for (const name of names) {
            expect(discoveredNames).toContain(name);
          }
          expect(discovered.length).toBe(names.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property: structural isolation ──────────────────────

/**
 * Helper to build a paragraph with multiple separate runs.
 * Each run gets its own formatting (bold for odd indices).
 */
const multiRunP = (texts: string[]) => {
  const runs = texts
    .map((t, i) => {
      const rPr = i % 2 === 1 ? "<w:rPr><w:b/></w:rPr>" : "";
      return `<w:r>${rPr}<w:t xml:space="preserve">${t}</w:t></w:r>`;
    })
    .join("");
  return `<w:p>${runs}</w:p>`;
};

describe("property: structural isolation", () => {
  test("editing one run in a multi-run paragraph preserves other runs", async () => {
    fc.assert(
      fc.property(
        xmlSafeWord,
        xmlSafeWord,
        xmlSafeWord,
        sentence,
        (textA, textB, textC, replacement) => {
          // Three runs: plain, bold, plain
          const xml = WRAP(multiRunP([textA, textB, textC]));
          const combined = textA + textB + textC;

          if (combined.length === 0 || combined === replacement) {
            return;
          }

          const extracted = {
            paragraphs: [{ index: 0, text: combined }],
            charCount: combined.length,
            view: "accepted" as const,
          };

          const { edits } = diffParagraphs(extracted, [
            { paragraphIndex: 0, newText: replacement },
          ]);

          const idGen = createIdGenerator(new Set());
          const result = applyEdits(xml, edits, AUTHOR, idGen);
          const accepted = extractAcceptedText(result);
          expect(accepted[0]).toBe(replacement);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("runs inside w:hyperlink are edited correctly", async () => {
    fc.assert(
      fc.property(
        xmlSafeWord,
        xmlSafeWord,
        sentence,
        (linkText, afterText, replacement) => {
          const xml = WRAP(
            "<w:p>" +
              '<w:hyperlink w:anchor="bookmark">' +
              "<w:r>" +
              `<w:t xml:space="preserve">${linkText}</w:t>` +
              "</w:r></w:hyperlink>" +
              "<w:r>" +
              `<w:t xml:space="preserve">${afterText}</w:t>` +
              "</w:r></w:p>",
          );
          const combined = linkText + afterText;

          if (combined.length === 0 || combined === replacement) {
            return;
          }

          const extracted = {
            paragraphs: [{ index: 0, text: combined }],
            charCount: combined.length,
            view: "accepted" as const,
          };

          const { edits } = diffParagraphs(extracted, [
            { paragraphIndex: 0, newText: replacement },
          ]);

          const idGen = createIdGenerator(new Set());
          const result = applyEdits(xml, edits, AUTHOR, idGen);
          const accepted = extractAcceptedText(result);
          expect(accepted[0]).toBe(replacement);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("insert in middle of multi-w:t run preserves sibling w:t text", async () => {
    fc.assert(
      fc.property(
        xmlSafeWord,
        xmlSafeWord,
        xmlSafeWord,
        (textA, textB, insertion) => {
          // Use code-point array to avoid splitting surrogate pairs at insert position
          const cpA = Array.from(textA);
          if (cpA.length < 2) {
            return;
          }

          const multiT =
            "<w:p><w:r>" +
            `<w:t xml:space="preserve">${textA}</w:t>` +
            `<w:t xml:space="preserve">${textB}</w:t>` +
            "</w:r></w:p>";
          const xml = WRAP(multiT);
          const combined = textA + textB;

          // Insert after first code point of textA
          const prefix = cpA[0];
          if (!prefix) {
            return;
          }
          const suffix = combined.slice(prefix.length);
          const newText = prefix + insertion + suffix;

          if (combined === newText) {
            return;
          }

          const extracted = {
            paragraphs: [{ index: 0, text: combined }],
            charCount: combined.length,
            view: "accepted" as const,
          };

          const { edits } = diffParagraphs(extracted, [
            { paragraphIndex: 0, newText },
          ]);

          const idGen = createIdGenerator(new Set());
          const result = applyEdits(xml, edits, AUTHOR, idGen);
          const accepted = extractAcceptedText(result);
          expect(accepted[0]).toBe(newText);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("multiple edits in the same paragraph produce correct result", async () => {
    fc.assert(
      fc.property(word, word, word, word, word, (w1, w2, w3, newW1, newW3) => {
        const oldText = `${w1} ${w2} ${w3}`;
        // Replace first and last words, keep middle
        const newText = `${newW1} ${w2} ${newW3}`;

        if (oldText === newText) {
          return;
        }

        const xml = WRAP(P(oldText));
        const extracted = {
          paragraphs: [{ index: 0, text: oldText }],
          charCount: oldText.length,
          view: "accepted" as const,
        };

        const { edits } = diffParagraphs(extracted, [
          { paragraphIndex: 0, newText },
        ]);

        const idGen = createIdGenerator(new Set());
        const result = applyEdits(xml, edits, AUTHOR, idGen);
        const accepted = extractAcceptedText(result);
        expect(accepted[0]).toBe(newText);
      }),
      { numRuns: 100 },
    );
  });

  test("deleting all text produces empty accepted text", async () => {
    fc.assert(
      fc.property(sentence, (text) => {
        const xml = WRAP(P(text));
        const extracted = {
          paragraphs: [{ index: 0, text }],
          charCount: text.length,
          view: "accepted" as const,
        };

        const { edits } = diffParagraphs(extracted, [
          { paragraphIndex: 0, newText: "" },
        ]);

        if (edits.length === 0) {
          return;
        }

        const idGen = createIdGenerator(new Set());
        const result = applyEdits(xml, edits, AUTHOR, idGen);
        const accepted = extractAcceptedText(result);
        expect(accepted[0]).toBe("");
        // All text should be wrapped in w:del
        expect(result).toContain("w:del");
      }),
      { numRuns: 100 },
    );
  });
});

// ── Regression: multi-w:t text ordering ──────────────────
//
// When a w:r contains multiple w:t nodes and an edit targets
// a non-first w:t, fragments must not reorder before the
// preceding text. This catches the bug Devin found where
// "Hello cruel world" → "Hello world" produced " worldHello".

describe("regression: multi-w:t text ordering", () => {
  test("partial delete of second w:t preserves text order", () => {
    // Two w:t nodes in one w:r: "Hello " and "cruel world"
    const xml = WRAP(
      "<w:p><w:r>" +
        '<w:t xml:space="preserve">Hello </w:t>' +
        '<w:t xml:space="preserve">cruel world</w:t>' +
        "</w:r></w:p>",
    );

    const edits = diffParagraphs(
      {
        paragraphs: [{ index: 0, text: "Hello cruel world" }],
        charCount: 17,
        view: "accepted",
      },
      [{ paragraphIndex: 0, newText: "Hello world" }],
    ).edits;

    const idGen = createIdGenerator(new Set());
    const result = applyEdits(xml, edits, AUTHOR, idGen);
    const accepted = extractAcceptedText(result);
    expect(accepted[0]).toBe("Hello world");
  });

  test("partial delete of second w:t with before+after fragments", () => {
    // "AAA" in first w:t, "BBBCCC" in second w:t.
    // Delete "BBB" → keep "AAA" + "CCC".
    const xml = WRAP(
      "<w:p><w:r>" +
        '<w:t xml:space="preserve">AAA</w:t>' +
        '<w:t xml:space="preserve">BBBCCC</w:t>' +
        "</w:r></w:p>",
    );

    const idGen = createIdGenerator(new Set());
    const result = applyEdits(
      xml,
      [
        {
          kind: "delete",
          paragraphIndex: 0,
          charOffset: 3,
          length: 3,
        },
      ],
      AUTHOR,
      idGen,
    );
    const accepted = extractAcceptedText(result);
    expect(accepted[0]).toBe("AAACCC");
  });

  test("insert into second w:t preserves preceding text", () => {
    const xml = WRAP(
      "<w:p><w:r>" +
        '<w:t xml:space="preserve">Hello </w:t>' +
        '<w:t xml:space="preserve">world</w:t>' +
        "</w:r></w:p>",
    );

    const edits = diffParagraphs(
      {
        paragraphs: [{ index: 0, text: "Hello world" }],
        charCount: 11,
        view: "accepted",
      },
      [
        {
          paragraphIndex: 0,
          newText: "Hello brave world",
        },
      ],
    ).edits;

    const idGen = createIdGenerator(new Set());
    const result = applyEdits(xml, edits, AUTHOR, idGen);
    const accepted = extractAcceptedText(result);
    expect(accepted[0]).toBe("Hello brave world");
  });

  test("property: partial edit of non-first w:t roundtrips", async () => {
    fc.assert(
      fc.property(xmlSafeWord, xmlSafeWord, word, (textA, textB, insert) => {
        if (textB.length < 2) {
          return;
        }

        const multiT =
          "<w:p><w:r>" +
          `<w:t xml:space="preserve">${textA}</w:t>` +
          `<w:t xml:space="preserve">${textB}</w:t>` +
          "</w:r></w:p>";
        const xml = WRAP(multiT);
        const combined = textA + textB;

        // Insert into the second w:t (after first char)
        const cpB = Array.from(textB);
        const newText = textA + cpB[0] + insert + cpB.slice(1).join("");

        if (combined === newText) {
          return;
        }

        const extracted = {
          paragraphs: [{ index: 0, text: combined }],
          charCount: combined.length,
          view: "accepted" as const,
        };

        const { edits } = diffParagraphs(extracted, [
          { paragraphIndex: 0, newText },
        ]);

        const idGen = createIdGenerator(new Set());
        const result = applyEdits(xml, edits, AUTHOR, idGen);
        const accepted = extractAcceptedText(result);
        expect(accepted[0]).toBe(newText);
      }),
      { numRuns: 200 },
    );
  });
});

// ── Property: adversarial text roundtrip ─────────────────
//
// These tests use varied text generators to exercise edge
// cases that clean word-based sentences miss: punctuation,
// whitespace variants, CJK, legal citations, repeated
// patterns, and long paragraphs.

/** Roundtrip helper: diff → apply → extract must match. */
const assertRoundtrip = (oldText: string, newText: string) => {
  if (oldText === newText || oldText.length === 0) {
    return;
  }
  const xml = WRAP(P(oldText));
  const extracted = {
    paragraphs: [{ index: 0, text: oldText }],
    charCount: oldText.length,
    view: "accepted" as const,
  };
  const { edits } = diffParagraphs(extracted, [{ paragraphIndex: 0, newText }]);
  const idGen = createIdGenerator(new Set());
  const result = applyEdits(xml, edits, AUTHOR, idGen);
  const accepted = extractAcceptedText(result);
  // eslint-disable-next-line vitest/no-standalone-expect
  expect(accepted[0]).toBe(newText);
};

describe("property: adversarial text roundtrip", () => {
  test("punctuation-heavy text (legal citations)", async () => {
    fc.assert(fc.property(punctuatedText, punctuatedText, assertRoundtrip), {
      numRuns: 100,
    });
  });

  test("whitespace variants (tabs, double spaces)", async () => {
    fc.assert(fc.property(whitespaceText, whitespaceText, assertRoundtrip), {
      numRuns: 100,
    });
  });

  test("CJK text roundtrip", async () => {
    fc.assert(fc.property(cjkText, cjkText, assertRoundtrip), {
      numRuns: 100,
    });
  });

  test("long paragraph roundtrip (50-200 words)", async () => {
    fc.assert(fc.property(longParagraph, longParagraph, assertRoundtrip), {
      numRuns: 20,
    });
  });

  test("repeated words: removing one occurrence", async () => {
    fc.assert(
      fc.property(repeatedText, (text) => {
        const words = text.split(" ");
        if (words.length < 3) {
          return;
        }
        // Remove the middle occurrence
        const mid = Math.floor(words.length / 2);
        const newWords = [...words.slice(0, mid), ...words.slice(mid + 1)];
        assertRoundtrip(text, newWords.join(" "));
      }),
      { numRuns: 100 },
    );
  });

  test("repeated words: replacing one occurrence", async () => {
    fc.assert(
      fc.property(repeatedText, word, (text, replacement) => {
        const words = text.split(" ");
        if (words.length < 3) {
          return;
        }
        const mid = Math.floor(words.length / 2);
        words[mid] = replacement;
        assertRoundtrip(text, words.join(" "));
      }),
      { numRuns: 100 },
    );
  });

  test("single character edit in long text", async () => {
    fc.assert(
      fc.property(
        longParagraph,
        word,
        fc.integer({ min: 0, max: 1_000_000 }),
        (text, insert, rawPos) => {
          // Use code-point-safe insertion position
          const codePoints = Array.from(text);
          if (codePoints.length < 2) {
            return;
          }
          const pos = rawPos % codePoints.length;
          const newText =
            codePoints.slice(0, pos).join("") +
            insert +
            codePoints.slice(pos).join("");
          assertRoundtrip(text, newText);
        },
      ),
      { numRuns: 20 },
    );
  });

  test("full Unicode graphemes roundtrip (emoji, combining marks, CJK)", async () => {
    fc.assert(fc.property(xmlSafeWord, xmlSafeWord, assertRoundtrip), {
      numRuns: 200,
    });
  });

  test("token boundary edit: adding/removing spaces between words", async () => {
    fc.assert(
      fc.property(word, word, word, (a, b, c) => {
        const spaced = `${a} ${b} ${c}`;
        // Collapse one space (merge two words)
        const collapsed = `${a} ${b}${c}`;
        assertRoundtrip(spaced, collapsed);
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property: known-problematic strings ──────────────────
//
// Handcrafted adversarial inputs that target specific edge
// cases in XML processing, Unicode handling, and diff
// alignment.

describe("property: known-problematic strings", () => {
  const problematicPairs: [string, string, string][] = [
    // Surrogate pairs (astral plane characters)
    ["𐀀𐀁𐀂", "𐀀𐀂", "surrogate pair deletion"],
    ["𐀀𐀁", "𐀂𐀀𐀁", "surrogate pair insertion"],
    // Combining marks (NFD decomposition)
    ["cafe\u0301", "cafe", "strip combining accent"],
    ["cafe", "cafe\u0301", "add combining accent"],
    ["re\u0301sume\u0301", "resume", "multiple combining marks"],
    // Zero-width characters
    ["hello\u200Bworld", "helloworld", "remove zero-width space"],
    ["hello\u200Dworld", "helloworld", "remove zero-width joiner"],
    // RTL/LTR marks (important for legal docs)
    ["\u200Ehello\u200F", "hello", "strip directional marks"],
    // Non-breaking space vs regular space
    ["hello\u00A0world", "hello world", "NBSP to regular space"],
    // Em-dash, en-dash (legal punctuation)
    ["§§ 1–5", "§§ 1—5", "en-dash to em-dash"],
    // CJK with punctuation
    ["契約第一条", "契約第二条", "CJK single char change"],
    // Very short strings
    ["a", "b", "single char replace"],
    ["ab", "a", "single char delete"],
    ["a", "ab", "single char append"],
    // Whitespace-only
    ["  ", " ", "reduce whitespace"],
    [" \t ", " ", "tab to space"],
    // Mixed scripts
    ["Hello мир 世界", "Hello мир мир", "mixed script edit"],
    // Parenthetical nesting (legal citations)

    ["(a)(1)(A)(i)", "(a)(2)(A)(i)", "nested parentheticals"],
    // Repeated identical words
    ["the the the the", "the the the", "remove repeated word"],
    ["aaa bbb aaa bbb", "aaa ccc aaa bbb", "change middle of repeated pattern"],
    // Leading/trailing whitespace
    [" hello ", " world ", "leading+trailing space"],
    // Only non-word characters
    ["... --- ...", "... === ...", "non-word char replace"],
    // Emoji (multi-code-unit)
    ["text 🎉 more", "text 🎊 more", "emoji replacement"],
  ];

  for (const [old, nw, label] of problematicPairs) {
    test(label, () => {
      assertRoundtrip(old, nw);
    });
  }
});

// ── Property: binary Unicode stress test ─────────────────
//
// Uses fc.string with unit: "binary" for maximum Unicode
// diversity, then sanitizes for XML. This is the closest
// equivalent to Hypothesis's text() strategy.

/** Any Unicode code point, sanitized for XML text nodes. */
const binaryUnicode = fc
  .string({
    minLength: 1,
    maxLength: 30,
    unit: "binary",
  })
  .map(sanitizeForXml)
  .filter((s) => s.length > 0);

describe("property: binary Unicode stress test", () => {
  test("roundtrip with arbitrary Unicode (binary unit)", async () => {
    fc.assert(fc.property(binaryUnicode, binaryUnicode, assertRoundtrip), {
      numRuns: 300,
    });
  });

  test("binary Unicode multi-w:t roundtrip", async () => {
    fc.assert(
      fc.property(
        binaryUnicode,
        binaryUnicode,
        binaryUnicode,
        (textA, textB, replacement) => {
          const multiT =
            "<w:p><w:r>" +
            `<w:t xml:space="preserve">${textA}</w:t>` +
            `<w:t xml:space="preserve">${textB}</w:t>` +
            "</w:r></w:p>";
          const xml = WRAP(multiT);
          const combined = textA + textB;

          if (combined.length === 0 || combined === replacement) {
            return;
          }

          const extracted = {
            paragraphs: [{ index: 0, text: combined }],
            charCount: combined.length,
            view: "accepted" as const,
          };

          const { edits } = diffParagraphs(extracted, [
            {
              paragraphIndex: 0,
              newText: replacement,
            },
          ]);

          const idGen = createIdGenerator(new Set());
          const result = applyEdits(xml, edits, AUTHOR, idGen);
          const accepted = extractAcceptedText(result);
          expect(accepted[0]).toBe(replacement);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("binary Unicode OOXML validation", async () => {
    fc.assert(
      fc.property(binaryUnicode, binaryUnicode, (oldText, newText) => {
        if (oldText === newText || oldText.length === 0) {
          return;
        }

        const xml = WRAP(P(oldText));
        const extracted = {
          paragraphs: [{ index: 0, text: oldText }],
          charCount: oldText.length,
          view: "accepted" as const,
        };

        const { edits } = diffParagraphs(extracted, [
          { paragraphIndex: 0, newText },
        ]);

        const idGen = createIdGenerator(new Set());
        const result = applyEdits(xml, edits, AUTHOR, idGen);

        const validation = validateOoxml(result);
        if (!validation.valid) {
          expect(validation.violations).toEqual([]);
        }
        expect(validation.valid).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
