import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { Block } from "./document-ast.js";
import { blocksNestedUnder } from "./provision-preview.js";
import {
  anchorWithin,
  E_SBIRKA_ANCHORS,
  SLOV_LEX_ANCHORS,
} from "./statute-anchor-scheme.js";
import type { StatuteAnchorScheme } from "./statute-anchor-scheme.js";
import {
  paragraphFromPreview,
  statuteListMarkerEnd,
  withStatuteListDepth,
} from "./statute-list.js";

/**
 * One publisher's anchor grammar, as a generator of the paths it mints and
 * the depth each path must be drawn at. The expected depth is stated per
 * publisher rather than computed by the code under test.
 */
type GrammarCase = {
  name: string;
  scheme: StatuteAnchorScheme;
  section: string;
  subsection: string;
  /** A trailing segment an item owns that is no item itself. */
  owned: readonly string[];
  /**
   * List kinds, outermost first, with the designator value each prints. A
   * path runs through any of them in this order, so an item may skip a
   * level (a section's own point) or repeat a kind (a letter in a letter).
   */
  kinds: readonly { kind: string; value: fc.Arbitrary<string> }[];
  segment: (kind: string, value: string) => string;
  separator: string;
  expectedDepth: (kinds: readonly string[]) => number;
};

const letter = fc.constantFrom("a", "b", "c", "aa", "bb");
const number = fc.integer({ min: 1, max: 40 }).map(String);
const subPoint = fc
  .tuple(number, fc.constantFrom("a", "b", "c"))
  .map(([point, suffix]) => `${point}${suffix}`);

const GRAMMARS = [
  {
    name: "e-Sbírka",
    scheme: E_SBIRKA_ANCHORS,
    section: "par",
    subsection: "odst",
    owned: ["table_1", "frag_2"],
    kinds: [
      { kind: "pism", value: letter },
      { kind: "pism", value: fc.constantFrom("aa", "bb") },
      { kind: "bod", value: number },
    ],
    segment: (kind, value) => `${kind}_${value}`,
    separator: "-",
    // Each item opens one more level, and a point sits two levels in even
    // where no letter holds it.
    expectedDepth: (kinds) =>
      Math.min(kinds.length + (kinds.at(0) === "bod" ? 1 : 0), 4),
  },
  {
    name: "Slov-Lex",
    scheme: SLOV_LEX_ANCHORS,
    section: "paragraf",
    subsection: "odsek",
    owned: ["text2", "text"],
    kinds: [
      { kind: "pismeno", value: letter },
      { kind: "bod", value: number },
      { kind: "bod", value: subPoint },
    ],
    segment: (kind, value) => `${kind}-${value}`,
    separator: ".",
    // Every item opens one more level, up to the deepest indent drawn.
    expectedDepth: (kinds) => Math.min(kinds.length, 4),
  },
] as const satisfies readonly GrammarCase[];

type GeneratedPath = {
  anchorId: string;
  /** The list kinds the path nests through, outermost first. */
  kinds: string[];
  /** The innermost list designator, when the path ends in an item. */
  designator: string | null;
};

/** A path this grammar mints: section, maybe a subsection, items, maybe an owned tail. */
const pathIn = (grammar: GrammarCase): fc.Arbitrary<GeneratedPath> =>
  fc
    .record({
      section: fc
        .tuple(fc.integer({ min: 1, max: 999 }), fc.constantFrom("", "a", "b"))
        .map(([value, suffix]) => `${String(value)}${suffix}`),
      subsection: fc.option(fc.integer({ min: 1, max: 12 }), { nil: null }),
      items: fc
        .subarray([...grammar.kinds])
        .chain((kinds) =>
          fc.tuple(
            ...kinds.map(({ kind, value }) =>
              value.map((designator) => ({ designator, kind })),
            ),
          ),
        ),
      owned: fc.option(fc.constantFrom(...grammar.owned), { nil: null }),
    })
    .map(({ items, owned, section, subsection }) => {
      const segments = [grammar.segment(grammar.section, section)];
      if (subsection !== null) {
        segments.push(grammar.segment(grammar.subsection, String(subsection)));
      }
      for (const { designator, kind } of items) {
        segments.push(grammar.segment(kind, designator));
      }
      if (owned !== null) {
        segments.push(owned);
      }
      const innermost = items.at(-1);
      return {
        anchorId: segments.join(grammar.separator),
        kinds: items.map(({ kind }) => kind),
        designator:
          owned === null && innermost !== undefined
            ? innermost.designator
            : null,
      };
    });

type SegmentsExtendOptions = {
  ancestor: string;
  anchor: string;
  separator: string;
};

/** Whether `ancestor`'s segments open `anchor`'s, compared whole, with more after. */
const segmentsExtend = ({
  ancestor,
  anchor,
  separator,
}: SegmentsExtendOptions): boolean => {
  const outer = ancestor.split(separator);
  const inner = anchor.split(separator);
  return (
    outer.length < inner.length &&
    outer.every((segment, index) => segment === inner.at(index))
  );
};

const words = fc.constantFrom(
  "jeden rok, je-li vedeno trestní stíhání pro přečin,",
  "zastávajúca funkciu v právnickej osobe,",
  "a dále",
);

describe("anchor paths a publisher mints", () => {
  test("a path is drawn as deep as it nests, and only its own designator hangs", () => {
    // Every publisher's grammar in one property, so its id is the title.
    const minted = fc
      .constantFrom(...GRAMMARS)
      .chain((grammar) => pathIn(grammar).map((path) => ({ grammar, path })));
    assertProperty(
      "a path is drawn as deep as it nests, and only its own designator hangs",
      fc.property(
        minted,
        fc.constantFrom(")", "."),
        words,
        ({ grammar, path: { anchorId, designator, kinds } }, closer, text) => {
          const printed =
            designator === null ? text : `${designator}${closer} ${text}`;
          const block = withStatuteListDepth(
            paragraphFromPreview({ anchorId, id: anchorId, text: printed }),
            grammar.scheme,
          );
          // Widened: the expectation counts levels, the AST names them.
          const depth: number | null = block.listDepth ?? null;
          expect(depth).toBe(
            kinds.length === 0 ? null : grammar.expectedDepth(kinds),
          );
          const end = statuteListMarkerEnd(block, grammar.scheme);
          expect(end === null ? null : printed.slice(0, end)).toBe(
            designator === null ? null : `${designator}${closer} `,
          );
          // Reading the depth again keeps it: the renderer may see a block
          // that already carries one.
          expect(withStatuteListDepth(block, grammar.scheme)).toBe(block);
        },
      ),
      { numRuns: 300 * GRAMMARS.length },
    );
  });

  for (const grammar of GRAMMARS) {
    test(`${grammar.name}: a path sits under each of its proper prefixes and under no other path`, () => {
      assertProperty(
        `statute-anchor-scheme.${grammar.name}.within`,
        fc.property(pathIn(grammar), pathIn(grammar), (path, other) => {
          const segments = path.anchorId.split(grammar.separator);
          for (let length = 1; length <= segments.length; length += 1) {
            expect(
              anchorWithin(grammar.scheme, {
                ancestor: segments.slice(0, length).join(grammar.separator),
                anchor: path.anchorId,
              }),
            ).toBe(length < segments.length);
          }
          expect(
            anchorWithin(grammar.scheme, {
              ancestor: other.anchorId,
              anchor: path.anchorId,
            }),
          ).toBe(
            segmentsExtend({
              ancestor: other.anchorId,
              anchor: path.anchorId,
              separator: grammar.separator,
            }),
          );
        }),
        { numRuns: 300 },
      );
    });

    test(`${grammar.name}: a cited block's preview is itself and the run of blocks its path owns`, () => {
      assertProperty(
        `statute-anchor-scheme.${grammar.name}.nested-under`,
        fc.property(
          fc.uniqueArray(pathIn(grammar), {
            minLength: 1,
            maxLength: 8,
            selector: ({ anchorId }) => anchorId,
          }),
          fc.nat(),
          (paths, pick) => {
            const blocks: Block[] = paths
              .map(({ anchorId }) => anchorId)
              .toSorted()
              .map((anchorId) =>
                paragraphFromPreview({ anchorId, id: anchorId, text: "x" }),
              );
            const start = pick % blocks.length;
            const cited =
              blocks.at(start) ?? panic("The pick is inside the list");
            const cut = blocks.findIndex(
              (block, index) =>
                index > start &&
                !segmentsExtend({
                  ancestor: cited.anchorId,
                  anchor: block.anchorId,
                  separator: grammar.separator,
                }),
            );
            expect(
              blocksNestedUnder({ blocks, scheme: grammar.scheme }, cited),
            ).toEqual(blocks.slice(start, cut === -1 ? blocks.length : cut));
          },
        ),
        { numRuns: 300 },
      );
    });
  }

  test("no publisher's paths state a list in another publisher's grammar", () => {
    const minted = fc
      .constantFrom(...GRAMMARS)
      .chain((minter) =>
        pathIn(minter).map(({ anchorId }) => ({ anchorId, minter })),
      );
    assertProperty(
      "no publisher's paths state a list in another publisher's grammar",
      fc.property(minted, ({ anchorId, minter }) => {
        const block = paragraphFromPreview({
          anchorId,
          id: anchorId,
          text: "a) x",
        });
        for (const reader of GRAMMARS) {
          if (reader.name !== minter.name) {
            expect(withStatuteListDepth(block, reader.scheme)).toBe(block);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
