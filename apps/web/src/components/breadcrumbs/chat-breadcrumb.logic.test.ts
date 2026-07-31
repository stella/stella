import { describe, expect, test } from "bun:test";

import { shouldFetchChatThreadTitle } from "@/components/breadcrumbs/chat-breadcrumb.logic";

describe("chat breadcrumb title lookup", () => {
  test("waits for the grouped thread lookup before requesting a title", () => {
    expect(
      shouldFetchChatThreadTitle({
        groupedTitle: undefined,
        threadExists: true,
      }),
    ).toBe(false);
  });

  test("does not request a title before a draft thread has been persisted", () => {
    expect(
      shouldFetchChatThreadTitle({
        groupedTitle: null,
        threadExists: undefined,
      }),
    ).toBe(false);
    expect(
      shouldFetchChatThreadTitle({
        groupedTitle: null,
        threadExists: false,
      }),
    ).toBe(false);
  });

  test("requests a missing grouped title for an empty persisted thread", () => {
    expect(
      shouldFetchChatThreadTitle({
        groupedTitle: null,
        threadExists: true,
      }),
    ).toBe(true);
  });

  test("uses the grouped title without a by-id request", () => {
    expect(
      shouldFetchChatThreadTitle({
        groupedTitle: "Churchill quotations",
        threadExists: true,
      }),
    ).toBe(false);
  });
});
