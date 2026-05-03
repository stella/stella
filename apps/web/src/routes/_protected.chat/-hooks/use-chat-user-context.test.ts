import { describe, expect, test } from "bun:test";

import {
  getWordEditAuthorName,
  getWordEditShortcut,
} from "@/routes/_protected.chat/-hooks/use-chat-user-context";

describe("getWordEditAuthorName", () => {
  test("prefers the explicit Word author name over the account name", () => {
    expect(
      getWordEditAuthorName({
        name: "Account Name",
        preferredName: "  Word Author  ",
      }),
    ).toBe("Word Author");
  });

  test("falls back to the account name", () => {
    expect(
      getWordEditAuthorName({
        name: "Account Name",
        preferredName: "",
      }),
    ).toBe("Account Name");
  });
});

describe("getWordEditShortcut", () => {
  test("trims the Word edit shortcut", () => {
    expect(getWordEditShortcut({ wordEditShortcut: "  JD  " })).toBe("JD");
  });
});
