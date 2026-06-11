import { describe, expect, test } from "bun:test";

import {
  getFindDialogOpenBehavior,
  shouldRefreshFindDialogSearch,
} from "./findReplaceDialogBehavior";

describe("find replace dialog behavior", () => {
  test("opens by resetting the search text from the initial selection", () => {
    expect(
      getFindDialogOpenBehavior({
        isOpen: true,
        initialSearchText: "contract",
      }),
    ).toEqual({
      type: "open",
      searchText: "contract",
      shouldFindInitialText: true,
    });
  });

  test("does not run an initial find for empty initial text", () => {
    expect(
      getFindDialogOpenBehavior({
        isOpen: true,
        initialSearchText: "",
      }),
    ).toEqual({
      type: "open",
      searchText: "",
      shouldFindInitialText: false,
    });
  });

  test("clears highlights when the dialog closes", () => {
    expect(
      getFindDialogOpenBehavior({
        isOpen: false,
        initialSearchText: "ignored",
      }),
    ).toEqual({
      type: "closed",
      shouldClearHighlights: true,
    });
  });

  test("refreshes search on option changes only for non-empty open searches", () => {
    expect(
      shouldRefreshFindDialogSearch({
        isOpen: true,
        searchText: "clause",
      }),
    ).toBe(true);
    expect(
      shouldRefreshFindDialogSearch({
        isOpen: true,
        searchText: "   ",
      }),
    ).toBe(false);
    expect(
      shouldRefreshFindDialogSearch({
        isOpen: false,
        searchText: "clause",
      }),
    ).toBe(false);
  });
});
