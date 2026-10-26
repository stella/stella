import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  createReaderTextQuoteLocator,
  placeReaderMarks,
  READER_TEXT_QUOTE_CONTEXT_LENGTH,
  readerTextQuoteContext,
  readerTextQuoteMatchesAt,
  readerTextQuoteOccurrences,
} from "./reader-text-quote.js";
import type {
  ReaderTextPiece,
  ReaderTextQuoteSelector,
} from "./reader-text-quote.js";

/** A mark as the reader stores it: the words at a position, with context. */
const markOn = (
  pieces: readonly ReaderTextPiece[],
  anchorId: string,
  quote: string,
  occurrence = 0,
): ReaderTextQuoteSelector => {
  const piece = pieces.find((candidate) => candidate.anchorId === anchorId);
  if (piece === undefined) {
    throw new Error(`No piece ${anchorId}`);
  }
  let startOffset = -1;
  for (let seen = 0; seen <= occurrence; seen += 1) {
    startOffset = piece.text.indexOf(quote, startOffset + 1);
  }
  if (startOffset === -1) {
    throw new Error(`No "${quote}" in ${anchorId}`);
  }
  const endOffset = startOffset + quote.length;
  return {
    blockAnchorId: anchorId,
    startOffset,
    endOffset,
    quote,
    ...readerTextQuoteContext(piece.text, { startOffset, endOffset }),
  };
};

const wordsAt = (
  pieces: readonly ReaderTextPiece[],
  placement: ReturnType<ReturnType<typeof createReaderTextQuoteLocator>>,
): string | null => {
  if (placement.status !== "placed") {
    return null;
  }
  const piece = pieces.find(
    (candidate) => candidate.anchorId === placement.blockAnchorId,
  );
  return piece?.text.slice(placement.startOffset, placement.endOffset) ?? null;
};

describe("reader marks across a re-parse", () => {
  // The publisher's hard-wrapped reasons, first read as three paragraphs and
  // then, re-parsed, with the first two joined: `p-reasons-2` moves from
  // "przepisy ustawy." to "Skarga została oddalona."
  const before = [
    { anchorId: "p-reasons-1", text: "Sąd rozważył" },
    { anchorId: "p-reasons-2", text: "przepisy ustawy." },
    { anchorId: "p-reasons-3", text: "Skarga została oddalona." },
  ];
  const after = [
    { anchorId: "p-reasons-1", text: "Sąd rozważył\nprzepisy ustawy." },
    { anchorId: "p-reasons-2", text: "Skarga została oddalona." },
  ];

  test("follows the words when joined paragraphs renumber the anchors", () => {
    const locate = createReaderTextQuoteLocator(after);
    const statute = locate(markOn(before, "p-reasons-2", "przepisy ustawy."));
    const ruling = locate(markOn(before, "p-reasons-3", "oddalona"));

    expect(statute).toEqual({
      status: "placed",
      blockAnchorId: "p-reasons-1",
      startOffset: 13,
      endOffset: 29,
    });
    expect(wordsAt(after, statute)).toBe("przepisy ustawy.");
    expect(wordsAt(after, ruling)).toBe("oddalona");
  });

  test("never draws the stored anchor's new words", () => {
    // The stored position, read naively, now holds "Skarga została o".
    const mark = markOn(before, "p-reasons-2", "przepisy ustawy.");
    expect(
      readerTextQuoteMatchesAt(after[1]?.text ?? "", {
        startOffset: mark.startOffset,
        endOffset: mark.endOffset,
        quote: mark.quote,
      }),
    ).toBe(false);
    expect(createReaderTextQuoteLocator(after)(mark)).not.toMatchObject({
      blockAnchorId: "p-reasons-2",
    });
  });

  test("follows the words when a split paragraph renumbers the anchors", () => {
    const split = [
      { anchorId: "p-1", text: "Sąd rozważył" },
      { anchorId: "p-2", text: "przepisy ustawy." },
      { anchorId: "p-3", text: "Skarga została" },
      { anchorId: "p-4", text: "oddalona." },
    ];
    const joined = [
      { anchorId: "p-1", text: "Sąd rozważył przepisy ustawy." },
      { anchorId: "p-2", text: "Skarga została oddalona." },
    ];
    const placement = createReaderTextQuoteLocator(split)(
      markOn(joined, "p-2", "oddalona"),
    );

    expect(placement).toMatchObject({ status: "placed", blockAnchorId: "p-4" });
    expect(wordsAt(split, placement)).toBe("oddalona");
  });

  test("tells a repeated quote apart by the words around it", () => {
    const original = [
      {
        anchorId: "p-1",
        text: "Na podstawie art. 5 ustawy sąd oddalił skargę.",
      },
      {
        anchorId: "p-2",
        text: "Na podstawie art. 5 ustawy organ umorzył postępowanie.",
      },
    ];
    // A heading parsed out of the text pushes both paragraphs down one.
    const reparsed = [
      { anchorId: "p-1", text: "Uzasadnienie" },
      { anchorId: "p-2", text: original[0]?.text ?? "" },
      { anchorId: "p-3", text: original[1]?.text ?? "" },
    ];
    const mark = markOn(original, "p-2", "art. 5 ustawy");
    // The stored position holds the same words in the other paragraph.
    expect(readerTextQuoteMatchesAt(reparsed[1]?.text ?? "", mark)).toBeTrue();

    expect(createReaderTextQuoteLocator(reparsed)(mark)).toEqual({
      status: "placed",
      blockAnchorId: "p-3",
      startOffset: mark.startOffset,
      endOffset: mark.endOffset,
    });
  });

  test("orphans a repeated quote nothing around it tells apart", () => {
    const original = [
      { anchorId: "p-1", text: "Uzasadnienie" },
      { anchorId: "p-2", text: "art. 5 ustawy" },
    ];
    const reparsed = [
      { anchorId: "p-1", text: "art. 5 ustawy" },
      { anchorId: "p-2", text: "Uzasadnienie" },
      { anchorId: "p-3", text: "art. 5 ustawy" },
    ];

    expect(
      createReaderTextQuoteLocator(reparsed)(
        markOn(original, "p-2", "art. 5 ustawy"),
      ),
    ).toEqual({ status: "orphaned", reason: "quote_ambiguous" });
  });

  test("never moves a mark onto the same words where its context is missing", () => {
    // Made on "QUOTE" after "before"; the passage is gone and the document
    // keeps the words only at its very start, with nothing before them.
    const mark = markOn(
      [{ anchorId: "p-1", text: "before QUOTE tail" }],
      "p-1",
      "QUOTE",
    );

    expect(
      createReaderTextQuoteLocator([{ anchorId: "p-1", text: "QUOTE tail" }])(
        mark,
      ),
    ).toEqual({ status: "orphaned", reason: "quote_not_found" });
    expect(
      createReaderTextQuoteLocator([
        { anchorId: "p-1", text: "other words" },
        { anchorId: "p-2", text: "QUOTE tail" },
      ])(markOn([{ anchorId: "p-1", text: "QUOTE" }], "p-1", "QUOTE")),
    ).toMatchObject({ status: "placed", blockAnchorId: "p-2" });
  });

  test("a split that leaves the twin at a block edge is not ambiguous", () => {
    // Two occurrences; the reader marked the second. A split puts the first
    // at the start of the document, where its prefix has nothing to match.
    const original = [
      {
        anchorId: "p-1",
        text: "art. 5 ustawy oraz dalej, a także art. 5 ustawy",
      },
    ];
    const mark = markOn(original, "p-1", "art. 5 ustawy", 1);
    const split = [
      { anchorId: "p-1", text: "art. 5 ustawy oraz dalej," },
      { anchorId: "p-2", text: "a także art. 5 ustawy" },
    ];

    expect(createReaderTextQuoteLocator(split)(mark)).toEqual({
      status: "placed",
      blockAnchorId: "p-2",
      startOffset: 8,
      endOffset: 21,
    });
  });

  test("compacts each block once, however many marks it holds", () => {
    // Work counted, not timed: every compaction reads the block's text once.
    const words = Array.from(
      { length: 2000 },
      (_unused, index) => `słowo${String(index)}`,
    );
    const text = words.join(" ");
    let reads = 0;
    const block = {
      anchorId: "p-1",
      get text() {
        reads += 1;
        return text;
      },
    };
    const marks = words
      .filter((_word, index) => index % 20 === 0)
      .map((word) => markOn([{ anchorId: "p-1", text }], "p-1", `${word} `));
    const locate = createReaderTextQuoteLocator([block]);

    for (const mark of marks) {
      expect(locate(mark).status).toBe("placed");
    }
    expect(marks.length).toBe(100);
    expect(reads).toBe(1);

    // The other path, every mark searched for after a re-parse, shares it.
    reads = 0;
    const moved = createReaderTextQuoteLocator([
      { anchorId: "p-0", text: "Nagłówek" },
      block,
    ]);
    for (const mark of marks) {
      expect(moved({ ...mark, blockAnchorId: "p-0" }).status).toBe("placed");
    }
    expect(reads).toBe(1);
  });

  test("orphans a mark whose words the text no longer has", () => {
    expect(
      createReaderTextQuoteLocator([
        { anchorId: "p-reasons-1", text: "Sąd rozważył." },
      ])(markOn(before, "p-reasons-3", "oddalona")),
    ).toEqual({ status: "orphaned", reason: "quote_not_found" });
  });

  test("keeps the marks it places and sets the rest aside with the reason", () => {
    const marks = [
      { ...markOn(before, "p-reasons-2", "przepisy ustawy."), id: "kept" },
      { ...markOn(before, "p-reasons-1", "rozważył"), id: "gone" },
    ];
    const result = placeReaderMarks(marks, [
      { anchorId: "p-1", text: "Sąd przepisy ustawy. rozpatrzył" },
    ]);

    expect(result.placed).toEqual([
      {
        ...marks[0],
        id: "kept",
        blockAnchorId: "p-1",
        startOffset: 4,
        endOffset: 20,
      },
    ]);
    expect(result.orphaned).toEqual([
      { mark: marks[1], reason: "quote_not_found" },
    ]);
  });
});

describe("a mark's stored context", () => {
  test("keeps the context length either side and never splits a pair", () => {
    // The context length falls inside an emoji's surrogate pair on both
    // sides, so a cut there would store half a character.
    const emoji = "😀";
    const filler = "a".repeat(READER_TEXT_QUOTE_CONTEXT_LENGTH - 1);
    const text = `x${emoji}${filler}QUOTE${filler}${emoji}x`;
    const startOffset = text.indexOf("QUOTE");
    const context = readerTextQuoteContext(text, {
      startOffset,
      endOffset: startOffset + "QUOTE".length,
    });

    expect(context).toEqual({ quotePrefix: filler, quoteSuffix: filler });
  });
});

/**
 * A document re-parsed: the same words, segmented into other paragraphs,
 * with new paragraphs (a heading the parser now recognises) in between.
 * Every word is unique except one repeated phrase, which always sits between
 * unique words when a mark is made, so what tells its occurrences apart is
 * the context and nothing else.
 */
const REPEATED = ["art.", "5", "ustawy"] as const;

type Token = { id: number; text: string };

type ReparseCase = {
  before: Token[][];
  after: Token[][];
  mark: { paragraph: number; from: number; to: number };
  joiner: " " | "\n";
};

const reparseCase = fc
  .record({
    paragraphs: fc.array(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
      { minLength: 1, maxLength: 5 },
    ),
    cuts: fc.array(fc.boolean(), { maxLength: 80 }),
    inserts: fc.array(fc.nat({ max: 12 }), { maxLength: 3 }),
    pick: fc.tuple(fc.nat(), fc.nat(), fc.nat()),
    joiner: fc.constantFrom(" " as const, "\n" as const),
  })
  .map(({ cuts, inserts, joiner, paragraphs, pick }): ReparseCase => {
    let nextId = 0;
    const unique = (): Token => {
      nextId += 1;
      return { id: nextId, text: `słowo${String(nextId)}` };
    };
    // Each paragraph: unique words, with the repeated phrase between two
    // unique words wherever the generator asked for it.
    const before = paragraphs.map((repeats) => {
      const tokens: Token[] = [unique()];
      for (const repeat of repeats) {
        if (repeat) {
          for (const text of REPEATED) {
            nextId += 1;
            tokens.push({ id: nextId, text });
          }
        }
        tokens.push(unique());
      }
      return tokens;
    });
    const all = before.flat();
    const after: Token[][] = [[]];
    for (const [index, token] of all.entries()) {
      after.at(-1)?.push(token);
      if (index < all.length - 1 && cuts[index % Math.max(cuts.length, 1)]) {
        after.push([]);
      }
    }
    for (const at of inserts) {
      nextId += 1;
      after.splice(at % (after.length + 1), 0, [
        { id: -nextId, text: `Nagłówek${String(nextId)}` },
      ]);
    }
    const paragraph = pick[0] % before.length;
    const length = before[paragraph]?.length ?? 1;
    const from = pick[1] % length;
    const to = from + 1 + (pick[2] % (length - from));
    return { before, after, mark: { paragraph, from, to }, joiner };
  });

const piecesOf = (
  paragraphs: readonly Token[][],
  joiner: string,
): ReaderTextPiece[] =>
  paragraphs.map((tokens, index) => ({
    anchorId: `p-${String(index + 1)}`,
    text: tokens.map((token) => token.text).join(joiner),
  }));

/** The token ids a span of a paragraph covers exactly, or null. */
const tokensCovering = (
  tokens: readonly Token[],
  joiner: string,
  startOffset: number,
  endOffset: number,
): number[] | null => {
  const covered: number[] = [];
  let offset = 0;
  let startsOnToken = false;
  let endsOnToken = false;
  for (const token of tokens) {
    const end = offset + token.text.length;
    if (offset === startOffset) {
      startsOnToken = true;
    }
    if (offset >= startOffset && end <= endOffset) {
      covered.push(token.id);
    }
    if (end === endOffset) {
      endsOnToken = true;
    }
    offset = end + joiner.length;
  }
  return startsOnToken && endsOnToken ? covered : null;
};

/** The mark the reader made on the case's paragraph, as it is stored. */
const selectorFor = ({ before, joiner, mark }: ReparseCase) => {
  const piece = piecesOf(before, joiner)[mark.paragraph];
  if (piece === undefined) {
    throw new Error("The generator picked no paragraph");
  }
  const tokens = before[mark.paragraph] ?? [];
  const marked = tokens.slice(mark.from, mark.to);
  const startOffset = tokens
    .slice(0, mark.from)
    .reduce((sum, token) => sum + token.text.length + joiner.length, 0);
  const quote = marked.map((token) => token.text).join(joiner);
  const endOffset = startOffset + quote.length;
  const selector: ReaderTextQuoteSelector = {
    blockAnchorId: piece.anchorId,
    startOffset,
    endOffset,
    quote,
    ...readerTextQuoteContext(piece.text, { startOffset, endOffset }),
  };
  return { marked, piece, quote, selector };
};

describe("reader marks over any re-segmentation", () => {
  test("a mark lands on the words it was made on, or is orphaned", () => {
    assertProperty(
      "a mark lands on the words it was made on, or is orphaned",
      fc.property(reparseCase, (reparse) => {
        const { after, joiner } = reparse;
        const { marked, piece, selector } = selectorFor(reparse);
        const { endOffset, startOffset } = selector;
        const beforePieces = piecesOf(reparse.before, joiner);
        const afterPieces = piecesOf(after, joiner);

        // The text unchanged: the mark stays exactly where it was.
        expect(createReaderTextQuoteLocator(beforePieces)(selector)).toEqual({
          status: "placed",
          blockAnchorId: piece.anchorId,
          startOffset,
          endOffset,
        });

        const placement = createReaderTextQuoteLocator(afterPieces)(selector);
        if (placement.status === "orphaned") {
          return;
        }
        const index = afterPieces.findIndex(
          (candidate) => candidate.anchorId === placement.blockAnchorId,
        );
        expect(
          tokensCovering(
            after[index] ?? [],
            joiner,
            placement.startOffset,
            placement.endOffset,
          ),
        ).toEqual(marked.map((token) => token.id));
      }),
    );
  });

  test("a re-segmented mark whose words occur once is placed", () => {
    assertProperty(
      "a re-segmented mark whose words occur once is placed",
      fc.property(reparseCase, (reparse) => {
        const { marked, quote, selector } = selectorFor(reparse);
        // Only the boundaries move: no new text next to the passage.
        const after = reparse.after.filter((tokens) =>
          tokens.every((token) => token.id > 0),
        );
        const afterPieces = piecesOf(after, reparse.joiner);
        const markedIds = marked.map((token) => token.id).join(",");
        const keptTogether = after.some((tokens) =>
          `,${tokens.map((token) => token.id).join(",")},`.includes(
            `,${markedIds},`,
          ),
        );
        const occurrences = afterPieces
          .map(
            (candidate) =>
              readerTextQuoteOccurrences(candidate.text, quote).length,
          )
          .reduce((sum, count) => sum + count, 0);
        if (!keptTogether || occurrences !== 1) {
          return;
        }

        expect(createReaderTextQuoteLocator(afterPieces)(selector).status).toBe(
          "placed",
        );
      }),
    );
  });
});
