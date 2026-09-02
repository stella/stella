import { describe, expect, test } from "bun:test";

import { CHAT_THREAD_PLACEHOLDER_TITLE } from "@stll/api-contract";

import { CHAT_THREAD_TITLE_MAX_LENGTH } from "@/api/db/schema";

import { CHAT_FORK_TITLE_MARKERS, forkedThreadTitle } from "./title";

describe("forkedThreadTitle", () => {
  test("marks the fork in the language of the request that created it", () => {
    expect(
      forkedThreadTitle({ locale: "en", title: "Termination clause" }),
    ).toBe("Forked - Termination clause");
    expect(
      forkedThreadTitle({ locale: "cs", title: "Termination clause" }),
    ).toBe("Větveno - Termination clause");
  });

  test("does not stack a marker when a fork is forked again", () => {
    const once = forkedThreadTitle({
      locale: "cs",
      title: "Termination clause",
    });
    expect(forkedThreadTitle({ locale: "fr", title: once })).toBe(once);
  });

  test("leaves the placeholder alone so titling and the UI still match it", () => {
    expect(
      forkedThreadTitle({ locale: "en", title: CHAT_THREAD_PLACEHOLDER_TITLE }),
    ).toBe(CHAT_THREAD_PLACEHOLDER_TITLE);
  });

  test("keeps a title that already fills the column within it", () => {
    const longest = "c".repeat(CHAT_THREAD_TITLE_MAX_LENGTH);
    const forked = forkedThreadTitle({ locale: "en", title: longest });
    expect(forked.length).toBe(CHAT_THREAD_TITLE_MAX_LENGTH);
    expect(forked.startsWith(CHAT_FORK_TITLE_MARKERS.en)).toBe(true);
  });
});
