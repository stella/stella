import { describe, expect, test } from "bun:test";

import {
  CARDS,
  EIGHTH,
  NINTH,
  selected,
  TENTH,
  textOf,
} from "./margin-citation-filter.fixture";
import {
  ALL_CITATIONS,
  citationIdsInSelection,
  MARGIN_CITATION_FILTER,
  marginCitationFilterKey,
  resolveMarginCitationFilter,
  selectionCitationFilter,
  visibleProvisionCards,
} from "./margin-citation-filter.logic";

const idsOf = (cards: readonly { citationIds: readonly string[] }[]) =>
  cards.flatMap(({ citationIds }) => citationIds);

describe("the margin's cited provisions", () => {
  test("the fixture's cards sit on the cited words of their paragraphs", () => {
    expect(
      CARDS.flatMap(({ ranges, startAnchorId }) =>
        ranges.map(({ end, start }) => textOf(startAnchorId).slice(start, end)),
      ),
    ).toEqual(["§ 72", "§ 257", "§ 87"]);
  });

  test("nothing focused or selected lists every card", () => {
    expect(visibleProvisionCards(CARDS, ALL_CITATIONS)).toBe(CARDS);
  });

  test("a focused paragraph keeps only the cards it cites", () => {
    const filter = resolveMarginCitationFilter({
      paragraph: { type: MARGIN_CITATION_FILTER.paragraph, paragraphId: "p-8" },
      selection: null,
    });
    expect(idsOf(visibleProvisionCards(CARDS, filter))).toEqual([
      "cite-72",
      "cite-257",
    ]);
  });

  test("a focused paragraph that cites nothing leaves no card", () => {
    expect(
      visibleProvisionCards(CARDS, {
        type: MARGIN_CITATION_FILTER.paragraph,
        paragraphId: "p-10",
      }),
    ).toEqual([]);
  });

  test("a selection finds a citation it partly covers and skips one it only touches", () => {
    const start = EIGHTH.indexOf("§ 72");
    const end = start + "§ 72".length;
    // From the middle of "§ 72" into the words after it.
    expect(
      citationIdsInSelection({
        cards: CARDS,
        spans: [selected("p-8", start + 2, end + 3)],
      }),
    ).toEqual(["cite-72"]);
    // Ending where the citation begins, or starting where it ends.
    for (const span of [
      selected("p-8", 0, start),
      selected("p-8", end, EIGHTH.indexOf("§ 257")),
    ]) {
      expect(citationIdsInSelection({ cards: CARDS, spans: [span] })).toEqual(
        [],
      );
    }
  });

  test("a selection over several paragraphs keeps what it touches in each", () => {
    const filter = selectionCitationFilter({
      cards: CARDS,
      spans: [
        selected("p-8", EIGHTH.indexOf("§ 257"), EIGHTH.length),
        selected("p-9", 0, NINTH.length),
      ],
    });
    expect(filter).toEqual({
      type: MARGIN_CITATION_FILTER.selection,
      citationIds: ["cite-257", "cite-87"],
    });
    expect(
      idsOf(visibleProvisionCards(CARDS, filter ?? ALL_CITATIONS)),
    ).toEqual(["cite-257", "cite-87"]);
  });

  test("every selection of a paragraph finds exactly the citations whose characters it covers", () => {
    const cited = CARDS.flatMap(({ ranges, startAnchorId }) =>
      startAnchorId === "p-8" ? ranges : [],
    );
    expect(cited).toHaveLength(2);
    for (let start = 0; start < EIGHTH.length; start += 1) {
      for (let end = start + 1; end <= EIGHTH.length; end += 1) {
        const expected = cited
          .filter((range) =>
            Array.from(
              { length: end - start },
              (_, index) => start + index,
            ).some((offset) => offset >= range.start && offset < range.end),
          )
          .map(({ citationId }) => citationId);
        expect(
          citationIdsInSelection({
            cards: CARDS,
            spans: [selected("p-8", start, end)],
          }),
        ).toEqual(expected);
      }
    }
  });

  test("no selected words is no filter; selected words citing nothing filter to no card", () => {
    expect(selectionCitationFilter({ cards: CARDS, spans: [] })).toBeNull();
    const nothingCited = selectionCitationFilter({
      cards: CARDS,
      spans: [selected("p-10", 0, TENTH.length)],
    });
    expect(nothingCited).toEqual({
      type: MARGIN_CITATION_FILTER.selection,
      citationIds: [],
    });
    expect(visibleProvisionCards(CARDS, nothingCited ?? ALL_CITATIONS)).toEqual(
      [],
    );
  });

  test("a selection outranks the focused paragraph, which returns once it clears", () => {
    const paragraphFilter = {
      type: MARGIN_CITATION_FILTER.paragraph,
      paragraphId: "p-8",
    };
    const selectionFilter = {
      type: MARGIN_CITATION_FILTER.selection,
      citationIds: ["cite-87"],
    };
    expect(
      resolveMarginCitationFilter({
        paragraph: paragraphFilter,
        selection: selectionFilter,
      }),
    ).toBe(selectionFilter);
    expect(
      resolveMarginCitationFilter({
        paragraph: paragraphFilter,
        selection: null,
      }),
    ).toBe(paragraphFilter);
    expect(
      resolveMarginCitationFilter({ paragraph: null, selection: null }),
    ).toBe(ALL_CITATIONS);
  });

  test("filters key by what they keep, so a repeated selection is the same filter", () => {
    const spans = [selected("p-8", 0, EIGHTH.length)];
    expect(
      marginCitationFilterKey(selectionCitationFilter({ cards: CARDS, spans })),
    ).toBe(
      marginCitationFilterKey(
        selectionCitationFilter({
          cards: CARDS,
          spans: [selected("p-8", 2, EIGHTH.length - 1)],
        }),
      ),
    );
    const keys = [
      null,
      ALL_CITATIONS,
      { type: MARGIN_CITATION_FILTER.paragraph, paragraphId: "p-8" },
      { type: MARGIN_CITATION_FILTER.paragraph, paragraphId: "p-9" },
      { type: MARGIN_CITATION_FILTER.selection, citationIds: [] },
      { type: MARGIN_CITATION_FILTER.selection, citationIds: ["cite-72"] },
    ].map(marginCitationFilterKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
