import { describe, expect, test } from "bun:test";

import {
  citedProvisionClick,
  CITED_PROVISION_CLICK,
  informativeProvisionTrail,
} from "@/components/legal-reader/cited-provision-link.logic";

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
