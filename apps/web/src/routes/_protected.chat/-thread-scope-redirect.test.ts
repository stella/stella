import { describe, expect, test } from "bun:test";

import { CHAT_THREAD_SCOPE_MISMATCH_CODE } from "@stll/api-contract/chat-thread-scope";

import { APIError } from "@/lib/errors/api";

import { readThreadScopeRedirect } from "./-thread-scope-redirect";

describe("global chat thread scope redirect", () => {
  test("targets the matter-scoped chat route from the typed API error", () => {
    const target = readThreadScopeRedirect(
      new APIError({
        status: 400,
        code: CHAT_THREAD_SCOPE_MISMATCH_CODE,
        details: { workspaceId: "matter-123" },
        message: "Chat thread scope does not match request",
      }),
      "thread-456",
    );

    expect(target).toEqual({
      to: "/chat/workspaces/$workspaceId/$threadId",
      params: { workspaceId: "matter-123", threadId: "thread-456" },
    });
  });

  test("does not redirect untyped failures", () => {
    expect(
      readThreadScopeRedirect(
        new APIError({ status: 404, message: "Chat thread not found" }),
        "thread-456",
      ),
    ).toBeNull();
  });
});
