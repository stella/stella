import { describe, expect, test } from "bun:test";

import { CHAT_THREAD_SCOPE_MISMATCH_CODE } from "@stll/api-contract/chat-thread-scope";

import { APIError } from "@/lib/errors/api";

import { readThreadScopeRedirect } from "./-thread-scope-redirect";
import { redirectThreadScopeError } from "./-thread-scope-redirect-boundary";

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
    const error = new APIError({
      status: 404,
      message: "Chat thread not found",
    });

    expect(readThreadScopeRedirect(error, "thread-456")).toBeNull();
    expect(() => redirectThreadScopeError(error, "thread-456")).toThrow(error);
  });

  test("raises the router redirect for a scope mismatch", () => {
    expect(() =>
      redirectThreadScopeError(
        new APIError({
          status: 400,
          code: CHAT_THREAD_SCOPE_MISMATCH_CODE,
          details: { workspaceId: "matter-123" },
          message: "Chat thread scope does not match request",
        }),
        "thread-456",
      ),
    ).toThrow(expect.objectContaining({ status: 307 }));
  });
});
