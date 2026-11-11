import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { Block, DocumentAst } from "./document-ast.js";
import {
  isPositionalBlockAnchor,
  positionalBlockAnchor,
  withStableBlockAnchors,
} from "./stable-block-anchors.js";

type Draft = {
  text: string;
  kind: "paragraph" | "heading";
  /** The court's printed number; paragraphs only. */
  number: number | null;
  /** A publisher anchor the parser read from the source, kept as is. */
  publisherAnchor: string | null;
};

const blockOf = (draft: Draft, ordinal: number): Block => {
  const anchorId =
    draft.publisherAnchor ??
    positionalBlockAnchor({
      kind: draft.kind === "heading" ? "h" : "p",
      ordinal,
    });
  const inlines = [{ type: "text" as const, text: draft.text }];
  return draft.kind === "heading"
    ? {
        id: `b${String(ordinal)}`,
        anchorId,
        type: "heading",
        level: 2,
        inlines,
        plainText: draft.text,
      }
    : {
        id: `b${String(ordinal)}`,
        anchorId,
        type: "paragraph",
        inlines,
        plainText: draft.text,
        ...(draft.number === null ? {} : { number: draft.number }),
      };
};

/** A parse: positional anchors are the block's place in the document. */
const parse = (drafts: readonly Draft[]): DocumentAst => ({
  version: 1,
  source: { system: "", documentId: "", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: drafts.map((draft, index) => blockOf(draft, index + 1)),
});

const anchorsByText = (ast: DocumentAst): Map<string, string> =>
  new Map(ast.blocks.map((block) => [block.plainText, block.anchorId]));

/** Drafts with distinct words, distinct court numbers and distinct publisher anchors. */
const drafts = fc
  .uniqueArray(fc.nat({ max: 10_000 }), { minLength: 1, maxLength: 30 })
  .chain((seeds) =>
    fc.tuple(
      ...seeds.map((seed) =>
        fc.record({
          text: fc.constant(`Odstavec ${String(seed)} rozsudku`),
          kind: fc.constantFrom<Draft["kind"]>("paragraph", "heading"),
          numbered: fc.boolean(),
          published: fc.nat({ max: 9 }),
        }),
      ),
    ),
  )
  .map((records) =>
    records.map(({ text, kind, numbered, published }, index): Draft => ({
      text,
      kind,
      number: kind === "paragraph" && numbered ? index + 1 : null,
      publisherAnchor: published === 0 ? `point${String(index + 1)}` : null,
    })),
  );

describe("stable block anchors", () => {
  test("a numbered paragraph is anchored by its court number, under its prefix", () => {
    const ast = parse([
      { text: "Výrok", kind: "heading", number: null, publisherAnchor: null },
      {
        text: "Žaloba se zamítá.",
        kind: "paragraph",
        number: 12,
        publisherAnchor: null,
      },
    ]);
    const prefixed = {
      ...ast,
      blocks: ast.blocks.map((block) => ({
        ...block,
        anchorId: `dissent-7-${block.anchorId}`,
      })),
    };
    expect(withStableBlockAnchors(ast).blocks.at(1)?.anchorId).toBe("n12");
    expect(withStableBlockAnchors(prefixed).blocks.at(1)?.anchorId).toBe(
      "dissent-7-n12",
    );
  });

  test("an in-document link follows its renamed target", () => {
    const ast = parse([
      {
        text: "Viz bod 2.",
        kind: "paragraph",
        number: null,
        publisherAnchor: null,
      },
      { text: "Bod 2.", kind: "paragraph", number: 2, publisherAnchor: null },
    ]);
    const linked: DocumentAst = {
      ...ast,
      blocks: ast.blocks.map((block, index) =>
        index === 0 && block.type === "paragraph"
          ? {
              ...block,
              inlines: [
                {
                  type: "link",
                  href: "#p-2",
                  children: [{ type: "text", text: "Viz bod 2." }],
                },
              ],
            }
          : block,
      ),
    };
    const first = withStableBlockAnchors(linked).blocks.at(0);
    expect(first?.type === "paragraph" ? first.inlines.at(0) : null).toEqual({
      type: "link",
      href: "#n2",
      children: [{ type: "text", text: "Viz bod 2." }],
    });
  });

  test("stable block anchors are unique, never positional, and keep publisher anchors", () => {
    assertProperty(
      "stable block anchors are unique, never positional, and keep publisher anchors",
      fc.property(drafts, (input) => {
        const ast = parse(input);
        const stable = withStableBlockAnchors(ast);
        const anchors = stable.blocks.map(({ anchorId }) => anchorId);
        expect(new Set(anchors).size).toBe(anchors.length);
        for (const [index, block] of stable.blocks.entries()) {
          const draft = input[index];
          expect(isPositionalBlockAnchor(block.anchorId)).toBe(false);
          if (draft?.publisherAnchor !== null && draft !== undefined) {
            expect(block.anchorId).toBe(draft.publisherAnchor);
          } else if (draft?.number !== null && draft !== undefined) {
            expect(block.anchorId).toBe(`n${String(draft.number)}`);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  test("stable block anchors are a fixed point", () => {
    assertProperty(
      "stable block anchors are a fixed point",
      fc.property(drafts, (input) => {
        const once = withStableBlockAnchors(parse(input));
        expect(withStableBlockAnchors(once)).toEqual(once);
      }),
      { numRuns: 300 },
    );
  });

  test("stable block anchors survive unrelated insertions, removals and reclassification", () => {
    assertProperty(
      "stable block anchors survive unrelated insertions, removals and reclassification",
      fc.property(
        drafts,
        fc.nat(),
        fc.nat(),
        fc.nat(),
        (input, insertAt, removeAt, flipAt) => {
          const before = anchorsByText(withStableBlockAnchors(parse(input)));
          const inserted: Draft = {
            text: "Nově vložený odstavec",
            kind: "paragraph",
            number: null,
            publisherAnchor: null,
          };
          const edited = [...input];
          edited.splice(insertAt % (edited.length + 1), 0, inserted);
          const removed = edited.splice(removeAt % edited.length, 1).at(0);
          // Reclassifying an unnumbered block is a heading read as a paragraph
          // or the other way round; its words are unchanged.
          const flipIndex = flipAt % edited.length;
          const flipped = edited[flipIndex];
          if (flipped?.number === null) {
            edited[flipIndex] = {
              ...flipped,
              kind: flipped.kind === "heading" ? "paragraph" : "heading",
            };
          }
          const after = anchorsByText(withStableBlockAnchors(parse(edited)));
          for (const [text, anchor] of before) {
            if (text === removed?.text) {
              continue;
            }
            expect(after.get(text)).toBe(anchor);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
