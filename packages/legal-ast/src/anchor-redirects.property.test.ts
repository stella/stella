import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  nextAnchorRedirects,
  planAnchorRedirects,
  replacedBlockAnchorsOf,
} from "./anchor-redirects.js";
import type { Block, DocumentAst } from "./document-ast.js";
import {
  blockAnchorText,
  positionalBlockAnchor,
  withStableBlockAnchors,
} from "./stable-block-anchors.js";

const paragraph = (text: string, ordinal: number): Block => ({
  id: `b${String(ordinal)}`,
  anchorId: positionalBlockAnchor({ kind: "p", ordinal }),
  type: "paragraph",
  inlines: [{ type: "text", text }],
  plainText: text,
});

/** A positional parse of the given paragraph texts. */
const parse = (texts: readonly string[]): DocumentAst => ({
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
  blocks: texts.map((text, index) => paragraph(text, index + 1)),
});

const textByAnchor = (ast: DocumentAst): Map<string, string> =>
  new Map(ast.blocks.map((block) => [block.anchorId, blockAnchorText(block)]));

/** Whether a redirect from `from` words to `to` words lands on the same text. */
const landsOnSameText = (from: string, to: string): boolean =>
  to === from || to.includes(from) || from.startsWith(to);

type Edit =
  | { type: "insert"; at: number }
  | { type: "remove"; at: number }
  | { type: "split"; at: number }
  | { type: "join"; at: number }
  | { type: "reword"; at: number };

const edits = fc.array(
  fc.record({
    type: fc.constantFrom<Edit["type"]>(
      "insert",
      "remove",
      "split",
      "join",
      "reword",
    ),
    at: fc.nat(),
  }),
  { maxLength: 6 },
);

/** Paragraphs long enough for partial matches, some repeated. */
const texts = fc.array(
  fc
    .nat({ max: 40 })
    .map((seed) => `Odstavec ${String(seed)} odůvodnění rozsudku soudu`),
  { minLength: 1, maxLength: 25 },
);

const applyEdits = (input: readonly string[], list: readonly Edit[]) => {
  const out = [...input];
  for (const edit of list) {
    if (out.length === 0) {
      out.push("Nový odstavec bez předchůdce");
      continue;
    }
    const at = edit.at % out.length;
    const text = out[at] ?? "";
    switch (edit.type) {
      case "insert":
        out.splice(at, 0, `Vložený odstavec číslo ${String(edit.at)}`);
        break;
      case "remove":
        out.splice(at, 1);
        break;
      case "split": {
        const middle = Math.floor(text.length / 2);
        out.splice(at, 1, text.slice(0, middle), text.slice(middle));
        break;
      }
      case "join":
        out.splice(at, 2, `${text} ${out[at + 1] ?? ""}`.trim());
        break;
      case "reword":
        out[at] = `${text} (opraveno)`;
        break;
      default:
        edit satisfies never;
    }
  }
  return out;
};

describe("anchor redirects", () => {
  test("anchor redirects land on the same text or report the anchor gone", () => {
    assertProperty(
      "anchor redirects land on the same text or report the anchor gone",
      fc.property(texts, edits, fc.boolean(), (input, list, legacy) => {
        // A legacy row keeps positional anchors; a rewritten one has stable ones.
        const replacedAst = legacy
          ? parse(input)
          : withStableBlockAnchors(parse(input));
        const current = withStableBlockAnchors(parse(applyEdits(input, list)));
        const before = textByAnchor(replacedAst);
        const after = textByAnchor(current);
        const redirects = planAnchorRedirects(
          replacedBlockAnchorsOf(replacedAst),
          current,
        );
        for (const [from, to] of redirects) {
          expect(after.has(from)).toBe(false);
          if (to === null) {
            continue;
          }
          const fromText = before.get(from) ?? "";
          const toText = after.get(to);
          expect(toText).toBeDefined();
          expect(landsOnSameText(fromText, toText ?? "")).toBe(true);
        }
        // Every replaced anchor the current document lost has an answer.
        for (const anchor of before.keys()) {
          expect(after.has(anchor) || redirects.has(anchor)).toBe(true);
        }
      }),
      { numRuns: 400 },
    );
  });

  test("an unchanged legacy document redirects every positional anchor to its own block", () => {
    const legacy = parse([
      "Výrok rozsudku soudu prvního stupně",
      "Odůvodnění rozsudku soudu prvního stupně",
      "Výrok rozsudku soudu prvního stupně",
    ]);
    const current = withStableBlockAnchors(legacy);
    const redirects = planAnchorRedirects(
      replacedBlockAnchorsOf(legacy),
      current,
    );
    expect([...redirects]).toEqual(
      legacy.blocks.map((block, index) => [
        block.anchorId,
        current.blocks[index]?.anchorId ?? null,
      ]),
    );
  });

  test("an opinion anchor never moves into a block whose place is unknown", () => {
    const words = "Odlišné stanovisko soudce k výroku o nákladech řízení";
    const opinion: Block = {
      id: "b1",
      anchorId: "op1-p-1",
      type: "paragraph",
      inlines: [{ type: "text", text: words }],
      plainText: words,
    };
    const replaced = { ...parse([]), blocks: [opinion] };
    // The main decision now quotes the opinion's words in a block the
    // publisher anchored; the opinion block itself is gone.
    const quoting = `${words} a k důvodům rozhodnutí.`;
    const current: DocumentAst = {
      ...parse([]),
      blocks: [
        {
          id: "b2",
          anchorId: "point12",
          type: "paragraph",
          inlines: [{ type: "text", text: quoting }],
          plainText: quoting,
        },
      ],
    };
    expect([
      ...planAnchorRedirects(replacedBlockAnchorsOf(replaced), current),
    ]).toEqual([["op1-p-1", null]]);
  });

  test("anchor redirects stay one hop across successive writes", () => {
    assertProperty(
      "anchor redirects stay one hop across successive writes",
      fc.property(texts, edits, edits, (input, first, second) => {
        const v1 = parse(input);
        const v2 = withStableBlockAnchors(parse(applyEdits(input, first)));
        const v3 = withStableBlockAnchors(
          parse(applyEdits(applyEdits(input, first), second)),
        );
        const anchors = (ast: DocumentAst) =>
          new Set(ast.blocks.map(({ anchorId }) => anchorId));
        const afterFirst = nextAnchorRedirects({
          stored: new Map(),
          step: planAnchorRedirects(replacedBlockAnchorsOf(v1), v2),
          currentAnchors: anchors(v2),
        });
        const afterSecond = nextAnchorRedirects({
          stored: afterFirst,
          step: planAnchorRedirects(replacedBlockAnchorsOf(v2), v3),
          currentAnchors: anchors(v3),
        });
        const current = anchors(v3);
        for (const [from, to] of afterSecond) {
          expect(current.has(from)).toBe(false);
          if (to !== null) {
            expect(current.has(to)).toBe(true);
          }
        }
        // A v1 anchor that was redirected stays answered after the second write.
        for (const from of afterFirst.keys()) {
          expect(current.has(from) || afterSecond.has(from)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
