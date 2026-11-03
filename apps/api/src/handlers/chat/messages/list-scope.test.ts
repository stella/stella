import { describe, expect, test } from "bun:test";

import { CHAT_THREAD_SCOPE_MISMATCH_CODE } from "@stll/api-contract/chat-thread-scope";

import { chatThreadScopeMismatchError } from "@/api/handlers/chat/chat-scope";
import { toSafeId } from "@/api/lib/branded-types";

const workspaceId = toSafeId<"workspace">(
  "019a3c44-1c4c-7000-8000-000000000001",
);

describe("chat message scope mismatch", () => {
  test("returns a typed redirect destination for a readable matter", async () => {
    const error = await chatThreadScopeMismatchError({
      workspaceId,
      getWorkspaceAccess: async () => ({ id: workspaceId, status: "active" }),
    });

    expect(error).toMatchObject({
      status: 400,
      code: CHAT_THREAD_SCOPE_MISMATCH_CODE,
      workspaceId,
    });
  });

  test("conceals the matter destination when it is unreadable", async () => {
    const error = await chatThreadScopeMismatchError({
      workspaceId,
      getWorkspaceAccess: async () => null,
    });

    expect(error).toMatchObject({
      status: 404,
      message: "Chat thread not found",
    });
    expect(error.code).toBeUndefined();
    expect(error.workspaceId).toBeUndefined();
  });
});
