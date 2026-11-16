import { describe, expect, test } from "bun:test";

import { CHAT_THREAD_SCOPE_MISMATCH_CODE } from "@stll/api-contract/chat-thread-scope";

import { APIError } from "@/lib/errors/api";

import { readThreadScopeRedirect } from "./-thread-scope-redirect";
import { loadThreadOrRedirect } from "./-thread-scope-redirect-boundary";

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

  test("does not redirect untyped failures", async () => {
    const notFound = new APIError({
      status: 404,
      message: "Chat thread not found",
    });

    expect(readThreadScopeRedirect(notFound, "thread-456")).toBeNull();
    const rejection = await loadThreadOrRedirect(async () => {
      throw notFound;
    }, "thread-456").then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBe(notFound);
  });

  test("raises the router redirect when the thread load fails with a scope mismatch", async () => {
    const mismatch = new APIError({
      status: 400,
      code: CHAT_THREAD_SCOPE_MISMATCH_CODE,
      details: { workspaceId: "matter-123" },
      message: "Chat thread scope does not match request",
    });
    const rejection = await loadThreadOrRedirect(async () => {
      throw mismatch;
    }, "thread-456").then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toEqual(expect.objectContaining({ status: 307 }));
  });

  test("resolves when the thread loads", async () => {
    const outcome = await loadThreadOrRedirect(
      async () => "loaded",
      "thread-456",
    ).then(
      () => "resolved",
      () => "rejected",
    );
    expect(outcome).toBe("resolved");
  });
});
