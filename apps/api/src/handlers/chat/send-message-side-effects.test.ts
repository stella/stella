import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import type { ChatThreadState } from "@/api/handlers/chat/send-message-thread";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { rollbackUnpersistedChatSideEffects } from "./send-message-side-effects";

const threadId = toSafeId<"chatThread">("00000000-0000-0000-0000-000000000001");
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000002");
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000003",
);
const rollbackToken = "rollback-token";

const threadData: ChatThreadState["data"] = {
  chatModel: null,
  contextMatterIds: [],
  dataWorkspaceIds: [workspaceId],
  id: threadId,
  messages: [],
  webSearchEnabled: false,
  workspaceId,
};

describe("send-message side-effect rollback", () => {
  test("deletes a created thread while its ownership marker matches", async () => {
    const deleteReturning = mock(async () => [{ id: threadId }]);
    const recordAuditEvent = mock(async () => undefined);
    const { safeDb } = createScopedDbMock({
      delete: () => ({
        where: () => ({ returning: deleteReturning }),
      }),
    });

    const result = await rollbackUnpersistedChatSideEffects({
      recordAuditEvent,
      safeDb,
      threadId,
      threadState: { type: "created", data: threadData, rollbackToken },
      uploadedFiles: [],
      userId,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(deleteReturning).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
  });

  test("preserves a created thread after an adopter changes its marker", async () => {
    const deleteReturning = mock(async () => []);
    const recordAuditEvent = mock(async () => undefined);
    const { safeDb } = createScopedDbMock({
      delete: () => ({
        where: () => ({ returning: deleteReturning }),
      }),
    });

    const result = await rollbackUnpersistedChatSideEffects({
      recordAuditEvent,
      safeDb,
      threadId,
      threadState: { type: "created", data: threadData, rollbackToken },
      uploadedFiles: [],
      userId,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(deleteReturning).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test("never deletes an existing thread", async () => {
    const deleteThread = mock(() => ({ where: async () => undefined }));
    const recordAuditEvent = mock(async () => undefined);
    const { safeDb } = createScopedDbMock({ delete: deleteThread });

    const result = await rollbackUnpersistedChatSideEffects({
      recordAuditEvent,
      safeDb,
      threadId,
      threadState: { type: "existing", data: threadData },
      uploadedFiles: [],
      userId,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(deleteThread).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});
