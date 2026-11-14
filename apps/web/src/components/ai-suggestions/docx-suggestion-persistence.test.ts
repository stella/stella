import { QueryClient } from "@tanstack/react-query";
import { expect, spyOn, test } from "bun:test";

import { createDocxSuggestionsRequest } from "./docx-suggestion-persistence";
import type { ReviewSuggestion } from "./review-store";

const suggestion = (id: string): ReviewSuggestion => ({
  id,
  origin: "chat",
  blockId: "block",
  type: "deleteBlock",
  summary: id,
  preview: { type: "deleteBlock", before: "text" },
  severity: "medium",
  area: "Body",
  status: "pending",
  applyMode: null,
  revisionIds: null,
  proposalBatchId: "proposal",
  undoHandle: null,
  pendingOperation: { id, type: "deleteBlock", blockId: "block" },
  snapshot: null,
  persisted: false,
});

test("a suggestion batch without operations does not send a create request", async () => {
  const fetch = spyOn(globalThis, "fetch");
  const queryClient = new QueryClient();
  try {
    for (const suggestions of [
      [],
      [{ ...suggestion("ignored"), pendingOperation: null }],
    ]) {
      const result = await createDocxSuggestionsRequest({
        queryClient,
        workspaceId: "matter",
        entityId: "document",
        chatThreadId: undefined,
        suggestions,
      });
      expect(result.unwrap()).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    queryClient.clear();
  }
});

test("the first persisted suggestion identifies the filtered batch intent", async () => {
  const queryClient = new QueryClient();
  const headers: Headers[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (...[_input, init]: Parameters<typeof globalThis.fetch>) => {
        headers.push(new Headers(init?.headers));
        return Response.json({
          items: [{ ref: "pending", id: "stored" }],
          createdAt: "2026-10-17T00:00:00.000Z",
        });
      },
      { preconnect: () => undefined },
    ),
  );
  try {
    const result = await createDocxSuggestionsRequest({
      queryClient,
      workspaceId: "matter",
      entityId: "document",
      chatThreadId: undefined,
      suggestions: [
        { ...suggestion("ignored"), pendingOperation: null },
        suggestion("pending"),
      ],
    });
    expect(result.unwrap()?.refToId).toEqual({ pending: "stored" });
    expect(headers).toHaveLength(1);
    expect(headers.at(0)?.get("Idempotency-Key")).toBe("pending");
  } finally {
    fetch.mockRestore();
    queryClient.clear();
  }
});
