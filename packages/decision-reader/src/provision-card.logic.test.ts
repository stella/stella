import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  E_SBIRKA_ANCHORS,
  SLOV_LEX_ANCHORS,
} from "@stll/legal-ast/statute-anchor-scheme";
import { normalizeUnicode } from "@stll/text-normalize";

import {
  fullProvisionOutcome,
  informativeProvisionTrail,
  PROVISION_CARD_SCOPE,
  PROVISION_WORDING_EMPHASIS,
  provisionCardPassage,
  provisionCardScope,
  provisionCardsOf,
  provisionWordingRuns,
} from "./provision-card.logic";
import type { CitedProvisionTarget } from "./reader-types";

describe("informative provision trail", () => {
  test("keeps the act and every enclosing heading the label does not name", () => {
    expect(
      informativeProvisionTrail({
        label: "§ 7",
        places: ["Občanský zákoník", "Část první", "Hlava II"],
      }),
    ).toEqual(["Občanský zákoník", "Část první", "Hlava II"]);
  });

  test("drops a place the label already spells out, ignoring case and spacing", () => {
    expect(
      informativeProvisionTrail({
        label: "čl. 140 odst. 4 Ústavy  České republiky",
        places: ["ústavy české republiky", "Hlava šestá"],
      }),
    ).toEqual(["Hlava šestá"]);
  });

  test("is empty when nothing is left to add", () => {
    expect(
      informativeProvisionTrail({
        label: "§ 2 zákona č. 89/2012 Sb.",
        places: ["", "  ", "zákona č. 89/2012 Sb."],
      }),
    ).toEqual([]);
  });

  test("shows a repeated place once", () => {
    expect(
      informativeProvisionTrail({
        label: "§ 7",
        places: ["Část první", "část  první"],
      }),
    ).toEqual(["Část první"]);
  });

  test("compares composed and decomposed diacritics alike", () => {
    const decomposed = normalizeUnicode("Hlava šestá", "NFD");
    expect(decomposed).not.toBe("Hlava šestá");
    expect(
      informativeProvisionTrail({
        label: "§ 90 Hlava šestá",
        places: [decomposed],
      }),
    ).toEqual([]);
  });
});

const CURRENT = "c7bbc901-27a1-4d00-b75a-111111111111";
const EARLIER = "c7bbc901-27a1-4d00-b75a-000000000000";

type TargetOptions = {
  documentId?: string | undefined;
  /** The part cited, or null for the whole provision. */
  part: string | null;
  section?: number | undefined;
};

const target = ({
  documentId = CURRENT,
  part,
  section = 226,
}: TargetOptions): CitedProvisionTarget => {
  const anchorId = `par_${String(section)}`;
  const cited = part === null ? anchorId : `${anchorId}-odst_${part}`;
  const id = documentId;
  return {
    document: {
      country: "cz",
      eli: "/eli/cz/sb/1963/99",
      id,
      slug: null,
      versionValidFrom: null,
    },
    payload: {
      anchorId,
      documentId: id,
      eli: "/eli/cz/sb/1963/99",
      highlightAnchorId: cited,
      jurisdiction: "CZE",
      provisionLabel: cited,
      statuteTitle: "Občanský soudní řád",
      versionCount: 1,
      versionValidFrom: null,
    },
    preview: null,
  };
};

const wording = (blockIds: readonly string[]) => ({
  anchorId: "par_226",
  blocks: blockIds.map((id) => ({ anchorId: id, id, text: id })),
  citedAnchorId: null,
  documentId: CURRENT,
  heading: null,
  headings: [],
  language: "cs",
});

/** A whole provision read in e-Sbírka's grammar. */
const czech = (whole: ReturnType<typeof wording>) => ({
  scheme: E_SBIRKA_ANCHORS,
  wording: whole,
});

describe("full provision reads", () => {
  test("only completed reads with text make the full provision available", () => {
    for (const whole of [null, wording([]), wording(["par_226-odst_1"])]) {
      expect(fullProvisionOutcome({ isPending: true, whole })).toEqual({
        type: "pending",
      });
    }
    for (const whole of [null, wording([])]) {
      expect(fullProvisionOutcome({ isPending: false, whole })).toEqual({
        type: "unavailable",
      });
    }
    const whole = wording(["par_226-odst_1"]);
    expect(fullProvisionOutcome({ isPending: false, whole })).toEqual({
      type: "text",
      wording: whole,
    });
  });
});

describe("provision cards of one paragraph", () => {
  test("a part cited twice makes one card that names it once", () => {
    const cards = provisionCardsOf([
      { id: "a", target: target({ part: "1" }) },
      { id: "b", target: target({ part: "1" }) },
    ]);
    expect(cards.map(({ id }) => id)).toEqual(["a"]);
    expect(
      cards.at(0)?.citations.map(({ payload }) => payload.highlightAnchorId),
    ).toEqual(["par_226-odst_1"]);
    // Both occurrences stay the card's, so either one in a selection finds it.
    expect(cards.at(0)?.citationIds).toEqual(["a", "b"]);
  });

  test("parts of one provision share its card in citation order", () => {
    const cards = provisionCardsOf([
      { id: "a", target: target({ part: "2" }) },
      { id: "b", target: target({ part: "1" }) },
      { id: "c", target: target({ part: "2" }) },
    ]);
    expect(cards).toHaveLength(1);
    expect(
      cards.at(0)?.citations.map(({ payload }) => payload.highlightAnchorId),
    ).toEqual(["par_226-odst_2", "par_226-odst_1"]);
    expect(
      provisionCardScope((cards.at(0) ?? panic("No card")).citations),
    ).toBe(PROVISION_CARD_SCOPE.parts);
  });

  test("another provision or another consolidation gets a card of its own", () => {
    const cards = provisionCardsOf([
      { id: "a", target: target({ part: "1" }) },
      { id: "b", target: target({ part: "1", section: 227 }) },
      { id: "c", target: target({ documentId: EARLIER, part: "1" }) },
      { id: "d", target: target({ part: "2", section: 227 }) },
    ]);
    expect(cards.map(({ citations, id }) => [id, citations.length])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 1],
    ]);
  });

  test("a citation of the whole provision makes the card quote it whole", () => {
    expect(
      provisionCardScope([target({ part: "1" }), target({ part: null })]),
    ).toBe(PROVISION_CARD_SCOPE.whole);
  });
});

describe("a provision card's passage", () => {
  test("waits for every cited part before quoting any", () => {
    expect(
      provisionCardPassage([
        { target: target({ part: "1" }), wording: wording(["odst_1"]) },
        { target: target({ part: "2" }), wording: undefined },
      ]),
    ).toEqual({ type: "pending" });
  });

  test("quotes each cited part once, in citation order, and marks them all", () => {
    const passage = provisionCardPassage([
      { target: target({ part: "2" }), wording: wording(["odst_2"]) },
      {
        target: target({ part: "1" }),
        wording: wording(["odst_1", "odst_1-a"]),
      },
      { target: target({ part: "1" }), wording: wording(["odst_1"]) },
      { target: target({ part: "3" }), wording: null },
    ]);
    if (passage.type !== "passage") {
      panic(`Expected a passage, got ${passage.type}`);
    }
    expect(passage.unavailable).toEqual(["par_226-odst_3"]);
    expect(passage.blocks.map(({ id }) => id)).toEqual([
      "odst_2",
      "odst_1",
      "odst_1-a",
    ]);
    expect([...passage.cited].toSorted()).toEqual([
      "odst_1",
      "odst_1-a",
      "odst_2",
    ]);
  });

  test("a whole-provision citation quotes the provision and marks the cited parts in it", () => {
    const passage = provisionCardPassage([
      { target: target({ part: "2" }), wording: wording(["odst_2"]) },
      {
        target: target({ part: null }),
        wording: wording(["odst_1", "odst_2", "odst_3"]),
      },
    ]);
    if (passage.type !== "passage") {
      panic(`Expected a passage, got ${passage.type}`);
    }
    expect(passage.blocks.map(({ id }) => id)).toEqual([
      "odst_1",
      "odst_2",
      "odst_3",
    ]);
    expect([...passage.cited]).toEqual(["odst_2"]);
  });
  test("identifies unavailable parts once in citation order beside available wording", () => {
    const passage = provisionCardPassage([
      { target: target({ part: "1" }), wording: wording(["odst_1"]) },
      { target: target({ part: "2" }), wording: null },
    ]);
    expect(passage).toMatchObject({
      type: "passage",
      blocks: [{ id: "odst_1" }],
      unavailable: ["par_226-odst_2"],
    });
    expect(
      provisionCardPassage([
        { target: target({ part: "3" }), wording: null },
        { target: target({ part: "2" }), wording: null },
        { target: target({ part: "3" }), wording: null },
      ]),
    ).toMatchObject({
      blocks: [],
      unavailable: ["par_226-odst_3", "par_226-odst_2"],
    });
  });

  test("empty previews identify unavailable parts beside available wording", () => {
    const passage = provisionCardPassage([
      { target: target({ part: "1" }), wording: wording(["odst_1"]) },
      { target: target({ part: "2" }), wording: wording([]) },
      { target: target({ part: "2" }), wording: null },
    ]);
    expect(passage).toMatchObject({
      type: "passage",
      blocks: [{ id: "odst_1" }],
      unavailable: ["par_226-odst_2"],
    });
    expect(
      provisionCardPassage([
        { target: target({ part: "1" }), wording: wording(["odst_1"]) },
        { target: target({ part: null }), wording: wording([]) },
      ]),
    ).toMatchObject({ blocks: [], unavailable: ["par_226"] });
  });

  test("only whole-provision wording determines availability when it is cited", () => {
    for (const partWording of [null, wording([]), wording(["odst_1"])]) {
      expect(
        provisionCardPassage([
          { target: target({ part: "1" }), wording: partWording },
          {
            target: target({ part: null }),
            wording: wording(["odst_1", "odst_2"]),
          },
        ]),
      ).toMatchObject({ unavailable: [] });
      expect(
        provisionCardPassage([
          { target: target({ part: "1" }), wording: partWording },
          { target: target({ part: null }), wording: null },
        ]),
      ).toMatchObject({ blocks: [], unavailable: ["par_226"] });
    }
  });
  test("full wording keeps missing-part notices and marks recovered parts by anchor", () => {
    for (const missingWording of [null, wording([])]) {
      const citations = [
        { target: target({ part: "1" }), wording: wording(["preview-1"]) },
        { target: target({ part: "2" }), wording: missingWording },
      ];
      const withoutPart = provisionCardPassage(
        citations,
        czech(wording(["par_226-odst_1", "par_226-odst_20"])),
      );
      if (withoutPart.type !== "passage") {
        panic("Expected a full passage");
      }
      expect(withoutPart.unavailable).toEqual(["par_226-odst_2"]);
      expect([...withoutPart.cited]).toEqual(["par_226-odst_1"]);
      expect(withoutPart.blocks.map(({ id }) => id)).toEqual([
        "par_226-odst_1",
        "par_226-odst_20",
      ]);
      const recovered = provisionCardPassage(
        citations,
        czech(
          wording([
            "par_226-odst_1",
            "par_226-odst_2",
            "par_226-odst_2-pism_a",
            "par_226-odst_20",
          ]),
        ),
      );
      if (recovered.type !== "passage") {
        panic("Expected a recovered full passage");
      }
      expect(recovered.unavailable).toEqual([]);
      expect([...recovered.cited]).toEqual([
        "par_226-odst_1",
        "par_226-odst_2",
        "par_226-odst_2-pism_a",
      ]);
      expect(provisionCardPassage(citations, czech(wording([])))).toEqual(
        provisionCardPassage(citations),
      );
    }
  });

  test("a cited Slov-Lex letter recovers its points from the full read", () => {
    const anchorId = "paragraf-15";
    const letter = "paragraf-15.pismeno-b";
    const base = target({ part: null });
    const cited: CitedProvisionTarget = {
      ...base,
      payload: {
        ...base.payload,
        anchorId,
        highlightAnchorId: letter,
        jurisdiction: "SVK",
        provisionLabel: letter,
      },
    };
    const full = {
      ...wording([
        "paragraf-15.pismeno-a",
        letter,
        "paragraf-15.pismeno-b.bod-1",
        "paragraf-15.pismeno-b.bod-1.bod-1a",
        "paragraf-15.pismeno-c",
      ]),
      anchorId,
    };
    const passage = provisionCardPassage([{ target: cited, wording: null }], {
      scheme: SLOV_LEX_ANCHORS,
      wording: full,
    });
    if (passage.type !== "passage") {
      panic("Expected a full passage");
    }
    expect(passage.unavailable).toEqual([]);
    expect([...passage.cited]).toEqual([
      letter,
      "paragraf-15.pismeno-b.bod-1",
      "paragraf-15.pismeno-b.bod-1.bod-1a",
    ]);
  });
});

describe("a provision card's quoted runs", () => {
  const blocks = [
    "par_5-odst_1",
    "par_5-odst_1-pism_a",
    "par_5-odst_1-pism_b",
    "par_5-odst_2",
    "par_5-odst_3",
    "par_5-odst_3-pism_a",
  ].map((anchorId) => ({ anchorId, id: anchorId, text: anchorId }));
  const runs = (cited: readonly string[]) =>
    provisionWordingRuns(blocks, new Set(cited)).map(
      ({ blocks: run, emphasis }) => ({
        emphasis,
        ids: run.map(({ id }) => id),
      }),
    );

  test("a quote that is all cited, or not cited at all, is one plain unit", () => {
    const whole = [
      {
        emphasis: PROVISION_WORDING_EMPHASIS.plain,
        ids: blocks.map(({ id }) => id),
      },
    ];
    expect(runs(blocks.map(({ id }) => id))).toEqual(whole);
    expect(runs([])).toEqual(whole);
  });

  test("a cited paragraph and its letters are one marked unit beside the context", () => {
    expect(
      runs([
        "par_5-odst_1",
        "par_5-odst_1-pism_a",
        "par_5-odst_1-pism_b",
        "par_5-odst_3-pism_a",
      ]),
    ).toEqual([
      {
        emphasis: PROVISION_WORDING_EMPHASIS.cited,
        ids: ["par_5-odst_1", "par_5-odst_1-pism_a", "par_5-odst_1-pism_b"],
      },
      {
        emphasis: PROVISION_WORDING_EMPHASIS.plain,
        ids: ["par_5-odst_2", "par_5-odst_3"],
      },
      {
        emphasis: PROVISION_WORDING_EMPHASIS.cited,
        ids: ["par_5-odst_3-pism_a"],
      },
    ]);
  });

  test("runs keep every block once, in order", () => {
    for (const cited of [
      [],
      ["par_5-odst_2"],
      ["par_5-odst_1", "par_5-odst_3"],
    ]) {
      expect(runs(cited).flatMap(({ ids }) => ids)).toEqual(
        blocks.map(({ id }) => id),
      );
    }
  });
});
