import { QueryClient } from "@tanstack/react-query";
import { describe, expect, spyOn, test } from "bun:test";

import {
  DOCX_SUGGESTIONS_PAGE_SIZE_MAX,
  DOCX_SUGGESTIONS_PENDING_MAX,
} from "@stll/api-contract";

import { getAnalytics } from "@/lib/analytics/provider";
import type { WebApiRoutes } from "@/lib/api";
import { toSafeId } from "@/lib/safe-id";
import {
  docxSuggestionsOptions,
  readDocxSuggestionCreatedAt,
} from "@/lib/workspaces/queries/docx-suggestions";

type SuggestionPage =
  WebApiRoutes["docx-suggestions"][":workspaceId"]["entity"][":entityId"]["get"]["response"][200];

describe("a suggestion createdAt read from the API", () => {
  test("the serialized timestamp the client receives reads back as the instant the server stamped", () => {
    const stamped = new Date("2026-09-15T11:30:00.123Z");
    const serialized = stamped.toISOString();

    const read = readDocxSuggestionCreatedAt(serialized);

    expect(read).toBeInstanceOf(Date);
    expect(read.getTime()).toBe(stamped.getTime());
  });

  test("an unreadable timestamp is a contract bug and panics", () => {
    expect(() => readDocxSuggestionCreatedAt("yesterday")).toThrow(
      "invalid createdAt",
    );
  });
});

test("pending hydration follows its cursor with cancellation until the final page", async () => {
  const queryClient = new QueryClient();
  const cursors: (string | null)[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (...[input, init]: Parameters<typeof globalThis.fetch>) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const cursor = url.searchParams.get("cursor");
        cursors.push(cursor);
        signals.push(init?.signal);
        expect(url.searchParams.get("status")).toBe("pending");
        return Response.json({
          items: [],
          limit: DOCX_SUGGESTIONS_PAGE_SIZE_MAX,
          nextCursor: cursor === null ? "last" : null,
        } satisfies SuggestionPage);
      },
      { preconnect: () => undefined },
    ),
  );
  try {
    expect(
      await queryClient.query(
        docxSuggestionsOptions({ workspaceId: "matter", entityId: "document" }),
      ),
    ).toEqual({ items: [] });
    expect(cursors).toEqual([null, "last"]);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  } finally {
    fetch.mockRestore();
    queryClient.clear();
  }
});

test("pending hydration retains its cap and reports the unread cursor", async () => {
  const queryClient = new QueryClient();
  const cursors: (string | null)[] = [];
  const pagesAtCap = Math.ceil(
    DOCX_SUGGESTIONS_PENDING_MAX / DOCX_SUGGESTIONS_PAGE_SIZE_MAX,
  );
  const capture = spyOn(getAnalytics(), "captureError").mockImplementation(
    () => undefined,
  );
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (...[input]: Parameters<typeof globalThis.fetch>) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const cursor = url.searchParams.get("cursor");
        cursors.push(cursor);
        const page = Number(cursor ?? 0);
        return Response.json({
          items: Array.from(
            { length: DOCX_SUGGESTIONS_PAGE_SIZE_MAX },
            (_, index) => ({
              id: toSafeId<"docxSuggestion">(
                `suggestion-${page * DOCX_SUGGESTIONS_PAGE_SIZE_MAX + index}`,
              ),
              opPayload: {
                type: "deleteBlock",
                blockId: "block",
                id: "operation",
              },
              comment: null,
              severity: "medium",
              area: "Body",
              status: "pending",
              appliedMode: null,
              createdAt: "2026-09-15T11:30:00.123Z",
              origin: "chat",
            }),
          ),
          limit: DOCX_SUGGESTIONS_PAGE_SIZE_MAX,
          nextCursor: page < pagesAtCap ? String(page + 1) : null,
        } satisfies SuggestionPage);
      },
      { preconnect: () => undefined },
    ),
  );
  try {
    const result = await queryClient.query(
      docxSuggestionsOptions({ workspaceId: "matter", entityId: "document" }),
    );
    expect(result.items).toHaveLength(DOCX_SUGGESTIONS_PENDING_MAX);
    expect(result.items.at(-1)?.id).toBe(
      toSafeId<"docxSuggestion">(
        `suggestion-${DOCX_SUGGESTIONS_PENDING_MAX - 1}`,
      ),
    );
    expect(cursors).toEqual(
      Array.from({ length: pagesAtCap }, (_, index) =>
        index === 0 ? null : String(index),
      ),
    );
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          `capped at ${DOCX_SUGGESTIONS_PENDING_MAX}`,
        ),
      }),
      expect.objectContaining({
        fingerprintKey: "docxSuggestionsOptions.queryFn:Error",
      }),
    );
  } finally {
    fetch.mockRestore();
    capture.mockRestore();
    queryClient.clear();
  }
});
