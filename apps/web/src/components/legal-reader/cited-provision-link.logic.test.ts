import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  citedProvisionClick,
  CITED_PROVISION_CLICK,
  informativeProvisionTrail,
  PROVISION_CARD_SCOPE,
  provisionCardPassage,
  provisionCardScope,
  provisionCardsOf,
} from "@/components/legal-reader/cited-provision-link.logic";
import type { CitedProvisionTarget } from "@/components/legal-reader/cited-provision-link.logic";
import { toSafeId } from "@/lib/safe-id";

const plain = {
  altKey: false,
  button: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

describe("cited provision click", () => {
  test("a plain primary click peeks at the wording", () => {
    expect(citedProvisionClick(plain)).toBe(CITED_PROVISION_CLICK.peek);
  });

  test("every browser navigation gesture keeps its meaning", () => {
    const gestures = [
      { ...plain, button: 1 },
      { ...plain, ctrlKey: true },
      { ...plain, metaKey: true },
      { ...plain, shiftKey: true },
      { ...plain, altKey: true },
    ];

    for (const gesture of gestures) {
      expect(citedProvisionClick(gesture)).toBe(CITED_PROVISION_CLICK.navigate);
    }
  });
});

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
    const decomposed = "Hlava šestá".normalize("NFD");
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
  const id = toSafeId<"legislationDocument">(documentId);
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
  documentId: toSafeId<"legislationDocument">(CURRENT),
  heading: null,
  headings: [],
  language: "cs",
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
});
