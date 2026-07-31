import { describe, expect, test } from "bun:test";

import { shouldFetchChatThreadTitle } from "@/components/breadcrumbs/chat-breadcrumb.logic";

describe("chat breadcrumb title lookup", () => {
  test("waits for the grouped thread lookup before requesting a title", () => {
    expect(
      shouldFetchChatThreadTitle({
        groupedTitle: undefined,
        lastActivityAt: "2026-07-31T04:30:08.968Z",
      }),
    ).toBe(false);
  });

  test("does not request a title before a draft thread has been persisted", () => {
    expect(
      shouldFetchChatThreadTitle({
        groupedTitle: null,
        lastActivityAt: undefined,
      }),
    ).toBe(false);
    expect(
      shouldFetchChatThreadTitle({
        groupedTitle: null,
        lastActivityAt: null,
      }),
    ).toBe(false);
  });

  test("requests a missing grouped title once the thread has activity", () => {
    expect(
      shouldFetchChatThreadTitle({
        groupedTitle: null,
        lastActivityAt: "2026-07-31T04:30:08.968Z",
      }),
    ).toBe(true);
  });

  test("uses the grouped title without a by-id request", () => {
    expect(
      shouldFetchChatThreadTitle({
        groupedTitle: "Churchill quotations",
        lastActivityAt: "2026-07-31T04:30:08.968Z",
      }),
    ).toBe(false);
  });
});
