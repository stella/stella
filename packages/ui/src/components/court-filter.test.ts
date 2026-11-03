import { describe, expect, test } from "bun:test";

import { toggleCourtSelection } from "./court-filter";

describe("court tier selections", () => {
  test("tier toggles form a deduplicated union and remove only the full selected tier", () => {
    const tier = ["NS", "ÚS"];
    expect(toggleCourtSelection(["KS", "NS"], tier)).toEqual([
      "KS",
      "NS",
      "ÚS",
    ]);
    expect(toggleCourtSelection(["KS", "NS", "ÚS"], tier)).toEqual(["KS"]);
    expect(
      toggleCourtSelection(toggleCourtSelection(["KS"], tier), tier),
    ).toEqual(["KS"]);
    expect(toggleCourtSelection(["NS", "ÚS"], ["NS"])).toEqual(["ÚS"]);
  });
});
