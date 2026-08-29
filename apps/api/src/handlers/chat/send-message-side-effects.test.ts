import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { envBase } from "@/api/env-base";
import type { ChatThreadState } from "@/api/handlers/chat/send-message-thread";
import type { UploadedChatFile } from "@/api/handlers/chat/upload-files";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { rollbackUnpersistedChatSideEffects } from "./send-message-side-effects";

const bucket = envBase.S3_BUCKET;
let fake: FakeS3;

const threadId = toSafeId<"chatThread">("00000000-0000-0000-0000-000000000001");
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000002");
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000003",
);
const rollbackToken = "rollback-token";
const pgDialect = new PgDialect();

const selectNoChatMessages = () => ({
  from: () => ({
    where: () => sql`select 1 where false`,
  }),
});

const threadData: ChatThreadState["data"] = {
  chatModel: null,
  chatReasoningEffort: null,
  contextMatterIds: [],
  dataWorkspaceIds: [workspaceId],
  id: threadId,
  messages: [],
  webSearchEnabled: false,
  workspaceId,
};

describe("send-message side-effect rollback", () => {
  beforeEach(() => {
    fake = startFakeS3();
  });

  afterEach(() => {
    fake.stop();
  });

  test("deletes a created thread while its ownership marker matches", async () => {
    const where = mock((condition: SQL) => ({
      returning: async () => {
        const { params } = pgDialect.sqlToQuery(condition);
        return params.includes(rollbackToken) && params.includes(userId)
          ? [{ id: threadId }]
          : [];
      },
    }));
    const recordAuditEvent = mock(async () => undefined);
    const { safeDb } = createScopedDbMock({
      delete: () => ({
        where,
      }),
      select: selectNoChatMessages,
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
    expect(where).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
  });

  test("preserves a created thread after an adopter changes its marker", async () => {
    const adoptedRollbackToken = "adopted-rollback-token";
    const where = mock((condition: SQL) => ({
      returning: async () => {
        const { params } = pgDialect.sqlToQuery(condition);
        return params.includes(adoptedRollbackToken) && params.includes(userId)
          ? [{ id: threadId }]
          : [];
      },
    }));
    const recordAuditEvent = mock(async () => undefined);
    const { safeDb } = createScopedDbMock({
      delete: () => ({
        where,
      }),
      select: selectNoChatMessages,
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
    expect(where).toHaveBeenCalledTimes(1);
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

  test("removes uploaded attachments without deleting an existing thread", async () => {
    const deleteRowsWhere = mock(async () => undefined);
    const deleteRows = mock(() => ({ where: deleteRowsWhere }));
    const recordAuditEvent = mock(async () => undefined);
    const { safeDb } = createScopedDbMock({ delete: deleteRows });
    const uploadedFile: UploadedChatFile = {
      id: toSafeId<"userFile">("00000000-0000-0000-0000-000000000004"),
      s3Key: "chat/thread/attachment.txt",
      thumbnailS3Key: null,
    };
    fake.put(bucket, uploadedFile.s3Key, "attachment body");

    const result = await rollbackUnpersistedChatSideEffects({
      recordAuditEvent,
      safeDb,
      threadId,
      threadState: { type: "existing", data: threadData },
      uploadedFiles: [uploadedFile],
      userId,
    });

    expect(Result.isOk(result)).toBe(true);
    // The attachment is gone from the store, under the key the row named.
    expect(fake.objects.size).toBe(0);
    expect(
      fake.requests.filter(({ method }) => method === "DELETE"),
    ).toMatchObject([{ bucket, key: uploadedFile.s3Key }]);
    expect(deleteRows).toHaveBeenCalledTimes(1);
    expect(deleteRowsWhere).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        resourceId: uploadedFile.id,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_FILE,
      }),
    ]);
  });
});
