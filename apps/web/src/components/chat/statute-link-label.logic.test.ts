import { describe, expect, test } from "bun:test";

import { labelledStatuteAnchorIds } from "@/components/chat/statute-link-label.logic";

const czech = (anchor: string | null, label: string) =>
  labelledStatuteAnchorIds({ anchor, country: "cze", label });

describe("the passage a statute link's label names", () => {
  test("a paragraph named on a link to its section", () => {
    expect(czech("par_240", "§ 240 odst. 3 OSŘ")).toEqual(["par_240-odst_3"]);
  });

  test("coordinated paragraphs are each named", () => {
    expect(czech("par_240", "§ 240 odst. 1 a 2 OSŘ")).toEqual([
      "par_240-odst_1",
      "par_240-odst_2",
    ]);
    expect(czech("par_57", "§ 57 odst. 1, 2 o. s. ř.")).toEqual([
      "par_57-odst_1",
      "par_57-odst_2",
    ]);
  });

  test("a sentence narrows no further than its paragraph", () => {
    expect(czech("par_240", "§ 240 odst. 1 věta druhá OSŘ")).toEqual([
      "par_240-odst_1",
    ]);
  });

  test("a letter below a paragraph the address already names", () => {
    expect(czech("par_5-odst_2", "§ 5 odst. 2 písm. b) ZOK")).toEqual([
      "par_5-odst_2-pism_b",
    ]);
  });

  test("a label that names nothing narrower leaves the address alone", () => {
    expect(czech("par_240", "§ 240 OSŘ")).toEqual([]);
    expect(czech("par_240-odst_3", "§ 240 odst. 3 OSŘ")).toEqual([]);
    expect(czech("par_240", "občanský soudní řád")).toEqual([]);
  });

  test("a label citing another provision never moves the landing", () => {
    expect(czech("par_240", "§ 241 odst. 1 OSŘ")).toEqual([]);
    expect(czech("par_5-odst_2", "§ 5 odst. 3 písm. b) ZOK")).toEqual([]);
  });

  test("a link with no provision, or from no supported grammar, is left as is", () => {
    expect(czech(null, "§ 240 odst. 3 OSŘ")).toEqual([]);
    expect(
      labelledStatuteAnchorIds({
        anchor: "par_240",
        country: "gbr",
        label: "§ 240 odst. 3",
      }),
    ).toEqual([]);
  });
});
