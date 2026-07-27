import { describe, expect, test } from "bun:test";

import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";

import {
  chunkDocument,
  formatHeadingPath,
} from "@/api/lib/corpus-index/chunking";

/**
 * The chunker's contract is an equality, not a heuristic: whatever it does
 * with sizing, the passages it emits must reproduce the document. These tests
 * therefore assert the equality over generated documents of varying shape,
 * plus the edges where the rule bends (oversized block, no AST, no content).
 */

const SEPARATOR = "\n\n";

const paragraph = (index: number, plainText: string): Block => ({
  id: `p${index}`,
  anchorId: `p${index}-anchor`,
  type: "paragraph",
  inlines: [],
  plainText,
});

const heading = (
  index: number,
  level: 1 | 2 | 3,
  plainText: string,
): Block => ({
  id: `h${index}`,
  anchorId: `h${index}-anchor`,
  type: "heading",
  level,
  inlines: [],
  plainText,
});

const astOf = (blocks: Block[]): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: "d", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
});

/**
 * Deterministic pseudo-random generator: the shapes below have to be
 * reproducible when a case fails, and a seeded LCG is cheaper than a property
 * framework for the two dimensions that matter (block count, block length).
 */
const lcg = (seed: number) => {
  let state = seed;
  return (bound: number): number => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state % bound;
  };
};

const HEADING_LEVELS = [1, 2, 3] as const;

const generateBlocks = (seed: number): Block[] => {
  const random = lcg(seed);
  const count = 1 + random(40);
  const blocks: Block[] = [];
  for (let index = 0; index < count; index += 1) {
    const words = 1 + random(600);
    const body = `b${index} ${"lorem ".repeat(words).trim()}`;
    blocks.push(
      random(5) === 0
        ? heading(
            index,
            HEADING_LEVELS[random(HEADING_LEVELS.length)] ?? 1,
            `Section ${index}`,
          )
        : paragraph(index, body),
    );
  }
  return blocks;
};

const nonBlank = (blocks: readonly Block[]): Block[] =>
  blocks.filter((block) => block.plainText.trim().length > 0);

describe("chunkDocument preserves the document", () => {
  test("concatenated passages reproduce the block text exactly, for any shape", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const blocks = generateBlocks(seed);
      const chunks = chunkDocument({
        ast: astOf(blocks),
        fallbackText: "unused",
      });

      // No text lost, no text indexed twice, order preserved. One equality
      // covers all three, and does not care what the separator is.
      expect(chunks.map((chunk) => chunk.text).join(SEPARATOR)).toBe(
        nonBlank(blocks)
          .map((block) => block.plainText)
          .join(SEPARATOR),
      );
    }
  });

  test("seq is dense and 0-based, for any shape", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const chunks = chunkDocument({
        ast: astOf(generateBlocks(seed)),
        fallbackText: "unused",
      });
      expect(chunks.map((chunk) => chunk.seq)).toEqual(
        chunks.map((_, index) => index),
      );
    }
  });

  test("every passage anchors to its own first block", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const blocks = nonBlank(generateBlocks(seed));
      const chunks = chunkDocument({
        ast: astOf(blocks),
        fallbackText: "unused",
      });
      const anchors = new Set(blocks.map((block) => block.anchorId));
      for (const chunk of chunks) {
        expect(anchors.has(chunk.anchorId ?? "")).toBe(true);
      }
      // Anchors are the deep-link target, so two passages must never share one.
      expect(new Set(chunks.map((chunk) => chunk.anchorId)).size).toBe(
        chunks.length,
      );
    }
  });

  test("no passage is headings only, for any shape", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const blocks = generateBlocks(seed);
      const chunks = chunkDocument({
        ast: astOf(blocks),
        fallbackText: "unused",
      });
      // Generated paragraphs start with their block marker; generated headings
      // do not, so a passage's segments say whether it carries body text.
      const hasBody = (text: string): boolean =>
        text.split(SEPARATOR).some((segment) => /^b\d+ /u.test(segment));

      if (blocks.every((block) => block.type === "heading")) {
        // A document that is nothing but headings has no body to attach them
        // to; indexing them is better than indexing nothing.
        expect(chunks).toHaveLength(1);
        continue;
      }
      for (const chunk of chunks) {
        // A heading-only passage would match a query and then show the reader
        // no content.
        expect(hasBody(chunk.text)).toBe(true);
      }
    }
  });

  test("blank blocks are dropped rather than emitted as empty passages", () => {
    const chunks = chunkDocument({
      ast: astOf([
        paragraph(0, "   "),
        paragraph(1, "real text"),
        paragraph(2, "\n\t"),
      ]),
      fallbackText: "unused",
    });
    expect(chunks).toHaveLength(1);
    expect(chunks.at(0)?.text).toBe("real text");
  });
});

describe("chunkDocument boundaries", () => {
  test("a block larger than the target band becomes its own passage, whole", () => {
    const oversized = `giant ${"word ".repeat(2000).trim()}`;
    const chunks = chunkDocument({
      ast: astOf([
        paragraph(0, "before"),
        paragraph(1, oversized),
        paragraph(2, "after"),
      ]),
      fallbackText: "unused",
    });

    const oversizedChunks = chunks.filter((chunk) =>
      chunk.text.includes("giant"),
    );
    expect(oversizedChunks).toHaveLength(1);
    // Never split mid-block: the passage is the block, not a prefix of it.
    expect(oversizedChunks.at(0)?.text).toBe(oversized);
  });

  test("a heading opens the passage that carries its section and never stands alone", () => {
    const body = "para ".repeat(400).trim();
    const chunks = chunkDocument({
      ast: astOf([
        heading(0, 1, "Rozsudek"),
        heading(1, 2, "Odůvodnění"),
        paragraph(2, body),
        paragraph(3, body),
        paragraph(4, body),
      ]),
      fallbackText: "unused",
    });

    // Two consecutive headings do not produce a heading-only passage.
    const first = chunks.at(0);
    expect(first?.text.startsWith("Rozsudek\n\nOdůvodnění\n\npara")).toBe(true);
    expect(first?.headingPath).toEqual(["Rozsudek", "Odůvodnění"]);

    // Continuation passages keep the section context without repeating it in
    // the body, so those heading terms are not counted N times.
    for (const chunk of chunks.slice(1)) {
      expect(chunk.headingPath).toEqual(["Rozsudek", "Odůvodnění"]);
      expect(chunk.text).not.toContain("Odůvodnění");
    }
  });

  test("headingPath is the ancestry, with siblings popped", () => {
    const chunks = chunkDocument({
      ast: astOf([
        heading(0, 1, "I"),
        heading(1, 2, "I.A"),
        paragraph(2, "a ".repeat(600).trim()),
        heading(3, 2, "I.B"),
        paragraph(4, "b ".repeat(600).trim()),
        heading(5, 1, "II"),
        paragraph(6, "c ".repeat(600).trim()),
      ]),
      fallbackText: "unused",
    });

    expect(chunks.map((chunk) => formatHeadingPath(chunk.headingPath))).toEqual(
      ["I > I.A", "I > I.B", "II"],
    );
  });
});

describe("chunkDocument never emits a body-less passage", () => {
  test("a heading trailing a full passage joins it instead of standing alone", () => {
    const body = "para ".repeat(400).trim();
    const chunks = chunkDocument({
      ast: astOf([
        heading(0, 1, "Odůvodnění"),
        paragraph(1, body),
        paragraph(2, body),
        heading(3, 1, "Poučení"),
      ]),
      fallbackText: "unused",
    });

    // The trailing heading has no section under it, so it cannot open a
    // passage; dropping it would lose text, so it joins the previous one.
    expect(chunks.at(-1)?.text.endsWith("Poučení")).toBe(true);
    expect(chunks.filter((chunk) => chunk.text === "Poučení")).toHaveLength(0);
    // Still lossless.
    expect(chunks.map((chunk) => chunk.text).join(SEPARATOR)).toBe(
      ["Odůvodnění", body, body, "Poučení"].join(SEPARATOR),
    );
  });

  test("a document of nothing but headings is emitted as one passage", () => {
    const chunks = chunkDocument({
      ast: astOf([
        heading(0, 1, "Rozsudek"),
        heading(1, 2, "Odůvodnění"),
        heading(2, 2, "Poučení"),
      ]),
      fallbackText: "",
    });

    // There is no body to attach them to, and the headings are the only text
    // the document has — indexing nothing would drop it from search entirely.
    expect(chunks).toHaveLength(1);
    expect(chunks.at(0)?.text).toBe(
      ["Rozsudek", "Odůvodnění", "Poučení"].join(SEPARATOR),
    );
  });

  // The 2s deadline matters: a regression here hangs instead of failing, and
  // the deadline turns it back into a readable failure.
  test("a non-positive heading level cannot spin the ancestry stack", () => {
    // `isDocumentAst` validates the envelope only, so a source that emits a
    // level of 0 reaches the chunker exactly like this. Parsed through the
    // production guard rather than cast, so the test proves the real path.
    const ast = parseDocumentAst(
      JSON.stringify({
        version: 1,
        source: { system: "t", documentId: "d", webUrl: "", printUrl: "" },
        metadata: {
          caseNumber: null,
          ecli: null,
          court: null,
          decisionDate: null,
          decisionType: null,
          keywords: [],
          statutes: [],
        },
        blocks: [
          {
            id: "h0",
            anchorId: "h0",
            type: "heading",
            level: 0,
            inlines: [],
            plainText: "Zero",
          },
          {
            id: "h1",
            anchorId: "h1",
            type: "heading",
            level: -3,
            inlines: [],
            plainText: "Negative",
          },
          {
            id: "p0",
            anchorId: "p0",
            type: "paragraph",
            inlines: [],
            plainText: "body",
          },
        ],
      }),
    );

    const chunks = chunkDocument({ ast, fallbackText: "unused" });
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      ["Zero", "Negative", "body"].join(SEPARATOR),
    ]);
  }, 2000);
});

describe("chunkDocument fallbacks", () => {
  test("no AST splits the plain text on blank lines, unanchored", () => {
    const first = "alfa ".repeat(400).trim();
    const second = "beta ".repeat(400).trim();
    const chunks = chunkDocument({
      ast: null,
      fallbackText: `${first}\n\n${second}`,
    });

    expect(chunks.map((chunk) => chunk.text).join(SEPARATOR)).toBe(
      `${first}${SEPARATOR}${second}`,
    );
    for (const chunk of chunks) {
      expect(chunk.anchorId).toBeNull();
      expect(chunk.headingPath).toEqual([]);
    }
  });

  test("junk blocks that pass the envelope guard degrade to the text", () => {
    // Exactly what `hasUsableAst` admits: its own tests accept
    // `{ version: 1, blocks: [{ a: 1 }] }`. Reading `.plainText` off any of
    // these throws, and the indexer would record a failed job and retry
    // forever for a document whose canonical text is fine.
    const ast = parseDocumentAst(
      JSON.stringify({
        version: 1,
        blocks: [{ junk: true }, 42, null],
      }),
    );
    expect(ast).not.toBeNull();

    const chunks = chunkDocument({
      ast,
      fallbackText: "the canonical text\n\nsecond paragraph",
    });

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      ["the canonical text", "second paragraph"].join(SEPARATOR),
    ]);
    for (const chunk of chunks) {
      expect(chunk.anchorId).toBeNull();
    }
  });

  test("one malformed block condemns the whole AST, not just itself", () => {
    // Skipping the bad block would silently drop whatever it held; the
    // canonical text is complete, so it is the safer source.
    const ast = parseDocumentAst(
      JSON.stringify({
        version: 1,
        blocks: [
          {
            id: "p0",
            anchorId: "p0",
            type: "paragraph",
            inlines: [],
            plainText: "a good block",
          },
          { id: "p1", anchorId: "p1", type: "paragraph", plainText: 7 },
        ],
      }),
    );

    const chunks = chunkDocument({ ast, fallbackText: "complete text" });

    expect(chunks.map((chunk) => chunk.text)).toEqual(["complete text"]);
  });

  test("a heading missing its level is not chunkable", () => {
    // The ancestry stack reads `level`; without it the heading cannot be
    // placed, so the document takes the text path.
    const ast = parseDocumentAst(
      JSON.stringify({
        version: 1,
        blocks: [
          { id: "h0", anchorId: "h0", type: "heading", plainText: "Nadpis" },
        ],
      }),
    );

    expect(
      chunkDocument({ ast, fallbackText: "text instead" }).map(
        (chunk) => chunk.text,
      ),
    ).toEqual(["text instead"]);
  });

  test("an AST that parsed but has no readable block degrades to the text", () => {
    const chunks = chunkDocument({
      ast: astOf([paragraph(0, "  ")]),
      fallbackText: "the text that survived",
    });
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "the text that survived",
    ]);
  });

  test("a document with neither AST nor text still yields one passage", () => {
    const chunks = chunkDocument({ ast: null, fallbackText: "   " });
    // Emitting nothing would drop a decision that still has indexable
    // metadata out of every filtered search.
    expect(chunks).toEqual([
      { seq: 0, text: "", anchorId: null, headingPath: [] },
    ]);
  });
});
