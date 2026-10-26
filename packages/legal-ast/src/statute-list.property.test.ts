import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  E_SBIRKA_LIST_SCHEME,
  paragraphFromPreview,
  SLOV_LEX_LIST_SCHEME,
  statuteListMarkerEnd,
  withStatuteListDepth,
} from "./statute-list.js";
import type { StatuteListScheme } from "./statute-list.js";

/**
 * One publisher's anchor grammar, as a generator of the paths it mints and
 * the depth each path must be drawn at. The expected depth is stated per
 * publisher rather than computed by the code under test.
 */
type GrammarCase = {
  name: string;
  scheme: StatuteListScheme;
  section: string;
  subsection: string;
  /** A trailing segment an item owns that is no item itself. */
  owned: readonly string[];
  /** List kinds, outermost first, with the designator value each prints. */
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
    scheme: E_SBIRKA_LIST_SCHEME,
    section: "par",
    subsection: "odst",
    owned: ["table_1", "frag_2"],
    kinds: [
      { kind: "pism", value: letter },
      { kind: "bod", value: number },
    ],
    segment: (kind, value) => `${kind}_${value}`,
    separator: "-",
    // A letter is one level in, a point two, whichever the path nests.
    expectedDepth: (kinds) => (kinds.includes("bod") ? 2 : 1),
  },
  {
    name: "Slov-Lex",
    scheme: SLOV_LEX_LIST_SCHEME,
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
        .integer({ min: 0, max: grammar.kinds.length })
        .chain((count) =>
          fc.tuple(
            ...grammar.kinds
              .slice(0, count)
              .map(({ kind, value }) =>
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

const words = fc.constantFrom(
  "jeden rok, je-li vedeno trestní stíhání pro přečin,",
  "zastávajúca funkciu v právnickej osobe,",
  "a dále",
);

describe("anchor paths a publisher mints", () => {
  for (const grammar of GRAMMARS) {
    test(`${grammar.name}: a path is drawn as deep as it nests, and only its own designator hangs`, () => {
      assertProperty(
        `statute-list.${grammar.name}.depth-and-hang`,
        fc.property(
          pathIn(grammar),
          fc.constantFrom(")", "."),
          words,
          ({ anchorId, designator, kinds }, closer, text) => {
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
      "statute-list.cross-publisher-isolation",
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
