import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads, userFiles } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  createChatAttachmentPart,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { THUMBNAIL_MIME_TYPE } from "@/api/lib/files/image-derivative";
import { createUserFileKey } from "@/api/lib/files/utils";
import { toUserFileUrl } from "@/api/lib/user-files/types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import getMessages from "../get-messages";
import { createForkThread } from "./create";

// Search indexing writes through the root (unscoped) database, which this
// fixture deliberately does not stand up; the handler takes it as an injectable
// boundary so the fork's own behaviour is what these tests observe.
const indexChatThreadMock = mock(async () => await Promise.resolve());
const forkThread = createForkThread({ indexChatThread: indexChatThreadMock });

// Exercises the fork endpoint against PGlite and an in-process object store:
// prefix selection, attachment duplication (source object AND thumbnail), the
// provenance columns, idempotent retry, and the cross-tenant / cross-user
// denials. The copy invariant the suite exists for is that a fork shares no
// storage with its source, in either direction.

type ForkCtx = Parameters<typeof forkThread.handler>[0];
type MessagesCtx = Parameters<typeof getMessages.handler>[0];

const BUCKET = process.env["S3_BUCKET"] ?? "stella";
const IMAGE_MIME_TYPE = "image/png";

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let fakeS3: FakeS3;
const seededThreadIds: SafeId<"chatThread">[] = [];

const scopedFor = ({
  organizationId,
  userId,
  workspaceIds,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceIds: SafeId<"workspace">[];
}): SafeDb =>
  toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, workspaceIds, organizationId, userId),
    ),
  );

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = scopedFor({
    organizationId: ids.orgA,
    userId: ids.userA1,
    workspaceIds: [ids.wsA1, ids.wsA2],
  });
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(userFiles)
      .where(inArray(userFiles.threadId, seededThreadIds));
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

beforeEach(() => {
  fakeS3 = startFakeS3();
});

afterEach(() => {
  fakeS3.stop();
});

type SeededAttachment = {
  fileId: SafeId<"userFile">;
  s3Key: string;
  thumbnailFileId: string;
  thumbnailKey: string;
};

const seedAttachment = async ({
  threadId,
  userId,
}: {
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
}): Promise<SeededAttachment> => {
  const fileId = toSafeId<"userFile">(Bun.randomUUIDv7());
  const thumbnailFileId = Bun.randomUUIDv7();
  const s3Key = createUserFileKey({
    fileId,
    mimeType: IMAGE_MIME_TYPE,
    userId,
  });
  const thumbnailKey = createUserFileKey({
    fileId: thumbnailFileId,
    mimeType: THUMBNAIL_MIME_TYPE,
    userId,
  });
  await testDb.insert(userFiles).values({
    fileName: "exhibit.png",
    id: fileId,
    mimeType: IMAGE_MIME_TYPE,
    placeholder: "data:image/png;base64,AAAA",
    s3Key,
    sha256Hex: "a".repeat(64),
    sizeBytes: 12,
    threadId,
    thumbnailFileId,
    userId,
  });
  fakeS3.put(BUCKET, s3Key, "source-bytes", IMAGE_MIME_TYPE);
  fakeS3.put(BUCKET, thumbnailKey, "thumb-bytes", THUMBNAIL_MIME_TYPE);
  return { fileId, s3Key, thumbnailFileId, thumbnailKey };
};

type SeededThread = {
  attachment: SeededAttachment | null;
  messageIds: SafeId<"chatMessage">[];
  threadId: SafeId<"chatThread">;
};

const seedThread = async ({
  dataWorkspaceIds = [],
  organizationId,
  texts,
  userId,
  withAttachment = false,
  workspaceId = null,
}: {
  dataWorkspaceIds?: SafeId<"workspace">[];
  organizationId?: SafeId<"organization">;
  texts: string[];
  userId?: SafeId<"user">;
  withAttachment?: boolean;
  workspaceId?: SafeId<"workspace"> | null;
}): Promise<SeededThread> => {
  const owner = userId ?? ids.userA1;
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    chatModel: "openai::gpt-5.4",
    chatReasoningEffort: "high",
    dataWorkspaceIds,
    id: threadId,
    organizationId: organizationId ?? ids.orgA,
    title: "Termination clause",
    titleSource: "user",
    userId: owner,
    webSearchEnabled: true,
    workspaceId,
  });

  const attachment = withAttachment
    ? await seedAttachment({ threadId, userId: owner })
    : null;

  const messageIds = texts.map(() =>
    toSafeId<"chatMessage">(Bun.randomUUIDv7()),
  );
  await testDb.insert(chatMessages).values(
    texts.map((text, index) => ({
      content: toPersistedChatMessageContentV3({
        data: [
          { content: text, type: "text" as const },
          ...(attachment !== null && index === 0
            ? [
                createChatAttachmentPart({
                  filename: "exhibit.png",
                  mimeType: IMAGE_MIME_TYPE,
                  url: toUserFileUrl(attachment.fileId),
                }),
              ]
            : []),
        ],
      }),
      // Microsecond-adjacent timestamps: the prefix boundary is resolved
      // in-database on (created_at, id), never on a truncated JS Date.
      createdAt: new Date(Date.parse("2026-08-31T09:00:00.000Z") + index),
      id: messageIds[index] ?? toSafeId<"chatMessage">(Bun.randomUUIDv7()),
      memoryExtractionEligible: index === 0,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      threadId,
      userId: owner,
      workspaceId,
    })),
  );

  return { attachment, messageIds, threadId };
};

const forkContext = ({
  db = safeDb,
  newThreadId,
  organizationId,
  threadId,
  upToMessageId,
  userId,
  workspaceId,
}: {
  db?: SafeDb;
  newThreadId: SafeId<"chatThread">;
  organizationId?: SafeId<"organization">;
  threadId: SafeId<"chatThread">;
  upToMessageId: SafeId<"chatMessage">;
  userId?: SafeId<"user">;
  workspaceId?: SafeId<"workspace">;
}): ForkCtx =>
  asTestRaw<ForkCtx>({
    body: { newThreadId, upToMessageId },
    getWorkspaceAccess: async (id: SafeId<"workspace">) =>
      await Promise.resolve(
        id === ids.wsA1 ? { id: ids.wsA1, status: "active" } : null,
      ),
    memberRole: { role: "owner" },
    params: { threadId },
    query: workspaceId ? { workspaceId } : {},
    recordAuditEvent: async () => await Promise.resolve(),
    request: new Request("http://localhost/v1/chat/threads/fork"),
    safeDb: db,
    session: { activeOrganizationId: organizationId ?? ids.orgA },
    user: { id: userId ?? ids.userA1 },
  });

const readFork = async (threadId: SafeId<"chatThread">) => {
  const [row] = await testDb
    .select({
      chatModel: chatThreads.chatModel,
      chatReasoningEffort: chatThreads.chatReasoningEffort,
      forkedFromMessageId: chatThreads.forkedFromMessageId,
      parentThreadId: chatThreads.parentThreadId,
      title: chatThreads.title,
      titleSource: chatThreads.titleSource,
      webSearchEnabled: chatThreads.webSearchEnabled,
      workspaceId: chatThreads.workspaceId,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  return row;
};

const readMessages = async (threadId: SafeId<"chatThread">) =>
  await testDb
    .select({
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
      id: chatMessages.id,
      memoryExtractionEligible: chatMessages.memoryExtractionEligible,
      role: chatMessages.role,
    })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));

const messageTexts = (
  rows: Awaited<ReturnType<typeof readMessages>>,
): string[] =>
  rows.flatMap((row) =>
    row.content.data.flatMap((part) =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "content" in part &&
      typeof part.content === "string"
        ? [part.content]
        : [],
    ),
  );

/**
 * A safe handler returns its payload directly and an Elysia status response on
 * failure, so a `code` property is how a rejection presents itself here.
 */
const expectForked = async (pending: ReturnType<typeof forkThread.handler>) => {
  const result = await pending;
  if ("code" in result) {
    throw new TypeError(`fork failed: ${JSON.stringify(result)}`);
  }
  return result;
};

/** The seeded message at `index`; a miss is a broken fixture, not a case. */
const messageAt = (seeded: SeededThread, index: number) => {
  const id = seeded.messageIds.at(index);
  if (id === undefined) {
    throw new TypeError(`seeded thread has no message at ${index}`);
  }
  return id;
};

test("copies the prefix up to a mid-thread message and records provenance", async () => {
  const source = await seedThread({
    texts: ["Ask one", "Answer one", "Ask two", "Answer two"],
  });
  const newThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(newThreadId);

  const result = await expectForked(
    forkThread.handler(
      forkContext({
        newThreadId,
        threadId: source.threadId,
        upToMessageId: messageAt(source, 1),
      }),
    ),
  );

  expect(result).toEqual({
    threadId: newThreadId,
    title: "Termination clause",
  });

  const copied = await readMessages(newThreadId);
  expect(messageTexts(copied)).toEqual(["Ask one", "Answer one"]);
  // Ids are re-minted; timestamps are not, so the fork's own keyset ordering
  // still matches the chronology it inherited.
  expect(copied.map((row) => row.id)).not.toEqual(
    source.messageIds.slice(0, 2),
  );
  const original = await readMessages(source.threadId);
  expect(copied.map((row) => row.createdAt)).toEqual(
    original.slice(0, 2).map((row) => row.createdAt),
  );
  expect(copied.map((row) => row.memoryExtractionEligible)).toEqual([
    true,
    false,
  ]);

  expect(await readFork(newThreadId)).toEqual({
    chatModel: "openai::gpt-5.4",
    chatReasoningEffort: "high",
    forkedFromMessageId: messageAt(source, 1),
    parentThreadId: source.threadId,
    title: "Termination clause",
    titleSource: "user",
    webSearchEnabled: true,
    workspaceId: null,
  });

  // The source is untouched.
  expect(messageTexts(original)).toEqual([
    "Ask one",
    "Answer one",
    "Ask two",
    "Answer two",
  ]);
});

test("forking at the head copies the whole thread", async () => {
  const source = await seedThread({ texts: ["Only ask", "Only answer"] });
  const newThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(newThreadId);

  await expectForked(
    forkThread.handler(
      forkContext({
        newThreadId,
        threadId: source.threadId,
        upToMessageId: messageAt(source, -1),
      }),
    ),
  );

  expect(messageTexts(await readMessages(newThreadId))).toEqual([
    "Only ask",
    "Only answer",
  ]);
});

test("duplicates attachments so neither thread's deletion touches the other's objects", async () => {
  const source = await seedThread({
    texts: ["See the exhibit", "Reviewed"],
    withAttachment: true,
  });
  const attachment = source.attachment;
  if (attachment === null) {
    throw new TypeError("expected a seeded attachment");
  }
  const newThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(newThreadId);

  await expectForked(
    forkThread.handler(
      forkContext({
        newThreadId,
        threadId: source.threadId,
        upToMessageId: messageAt(source, 0),
      }),
    ),
  );

  const [copiedFile] = await testDb
    .select({
      id: userFiles.id,
      placeholder: userFiles.placeholder,
      s3Key: userFiles.s3Key,
      thumbnailFileId: userFiles.thumbnailFileId,
    })
    .from(userFiles)
    .where(eq(userFiles.threadId, newThreadId))
    .limit(1);
  if (!copiedFile) {
    throw new TypeError("expected the fork to own a duplicated file row");
  }

  expect(copiedFile.id).not.toBe(attachment.fileId);
  expect(copiedFile.s3Key).not.toBe(attachment.s3Key);
  // The thumbnail's key is derived from `thumbnailFileId` at delete time, so
  // reusing that id would silently share one object between the two threads.
  expect(copiedFile.thumbnailFileId).not.toBe(attachment.thumbnailFileId);
  const copiedThumbnailKey = createUserFileKey({
    fileId: copiedFile.thumbnailFileId ?? "",
    mimeType: THUMBNAIL_MIME_TYPE,
    userId: ids.userA1,
  });
  expect(copiedThumbnailKey).not.toBe(attachment.thumbnailKey);

  // Both objects exist independently in storage.
  expect(fakeS3.objects.has(`${BUCKET}/${copiedFile.s3Key}`)).toBe(true);
  expect(fakeS3.objects.has(`${BUCKET}/${copiedThumbnailKey}`)).toBe(true);
  expect(fakeS3.objects.has(`${BUCKET}/${attachment.s3Key}`)).toBe(true);
  expect(fakeS3.objects.has(`${BUCKET}/${attachment.thumbnailKey}`)).toBe(true);

  // The copied message points at the fork's own file, not the source's.
  const copiedMessages = await readMessages(newThreadId);
  const serialized = JSON.stringify(copiedMessages.at(0)?.content);
  expect(serialized).toContain(toUserFileUrl(copiedFile.id));
  expect(serialized).not.toContain(toUserFileUrl(attachment.fileId));
});

test("a retried fork returns the existing copy instead of duplicating it", async () => {
  const source = await seedThread({ texts: ["Ask", "Answer"] });
  const newThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(newThreadId);
  const context = () =>
    forkContext({
      newThreadId,
      threadId: source.threadId,
      upToMessageId: messageAt(source, 0),
    });

  await expectForked(forkThread.handler(context()));
  await expectForked(forkThread.handler(context()));

  expect(await readMessages(newThreadId)).toHaveLength(1);
});

test("a thread id already used for a different boundary is a conflict", async () => {
  const source = await seedThread({ texts: ["Ask", "Answer"] });
  const newThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(newThreadId);

  await expectForked(
    forkThread.handler(
      forkContext({
        newThreadId,
        threadId: source.threadId,
        upToMessageId: messageAt(source, 0),
      }),
    ),
  );

  const conflict = await forkThread.handler(
    forkContext({
      newThreadId,
      threadId: source.threadId,
      upToMessageId: messageAt(source, 1),
    }),
  );

  expect(conflict).toMatchObject({ code: 409 });
});

test("a retried fork still converges after the source thread was deleted", async () => {
  const source = await seedThread({ texts: ["Ask", "Answer"] });
  const newThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(newThreadId);
  const context = () =>
    forkContext({
      newThreadId,
      threadId: source.threadId,
      upToMessageId: messageAt(source, 0),
    });

  await expectForked(forkThread.handler(context()));
  await testDb.delete(chatThreads).where(eq(chatThreads.id, source.threadId));

  // The identical request again: the source is gone (fork's parent is now
  // null), but the durable copy must be returned, not a 404 or a duplicate.
  const retried = await expectForked(forkThread.handler(context()));
  expect(retried.threadId).toBe(newThreadId);
  expect(await readMessages(newThreadId)).toHaveLength(1);
});

test("a request naming the wrong source cannot adopt an existing fork", async () => {
  const source = await seedThread({ texts: ["Ask", "Answer"] });
  const other = await seedThread({ texts: ["Elsewhere"] });
  const newThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(newThreadId);

  await expectForked(
    forkThread.handler(
      forkContext({
        newThreadId,
        threadId: source.threadId,
        upToMessageId: messageAt(source, 0),
      }),
    ),
  );

  // Same fork id and boundary message, but claimed against another thread:
  // the fork's live parent pins its identity to the real source.
  const denied = await forkThread.handler(
    forkContext({
      newThreadId,
      threadId: other.threadId,
      upToMessageId: messageAt(source, 0),
    }),
  );

  expect(denied).toMatchObject({ code: 409 });
});

test("a boundary message from another thread is a 404", async () => {
  const source = await seedThread({ texts: ["Ask", "Answer"] });
  const other = await seedThread({ texts: ["Elsewhere"] });
  const newThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());

  const denied = await forkThread.handler(
    forkContext({
      newThreadId,
      threadId: source.threadId,
      upToMessageId: messageAt(other, 0),
    }),
  );

  expect(denied).toMatchObject({ code: 404 });
  expect(await readFork(newThreadId)).toBeUndefined();
});

test("another user in the same organization cannot fork the thread", async () => {
  const source = await seedThread({ texts: ["Ask", "Answer"] });
  const newThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());

  const denied = await forkThread.handler(
    forkContext({
      db: scopedFor({
        organizationId: ids.orgA,
        userId: ids.userA2,
        workspaceIds: [ids.wsA2],
      }),
      newThreadId,
      threadId: source.threadId,
      upToMessageId: messageAt(source, 0),
      userId: ids.userA2,
    }),
  );

  expect(denied).toMatchObject({ code: 404 });
  expect(await readFork(newThreadId)).toBeUndefined();
});

test("a reader in another organization cannot fork the thread", async () => {
  const source = await seedThread({ texts: ["Ask", "Answer"] });
  const newThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());

  const denied = await forkThread.handler(
    forkContext({
      db: scopedFor({
        organizationId: ids.orgB,
        userId: ids.userB1,
        workspaceIds: [ids.wsB1],
      }),
      newThreadId,
      organizationId: ids.orgB,
      threadId: source.threadId,
      upToMessageId: messageAt(source, 0),
      userId: ids.userB1,
    }),
  );

  expect(denied).toMatchObject({ code: 404 });
  expect(await readFork(newThreadId)).toBeUndefined();
});

test("the fork keeps the parent's data scope and stays visible to it", async () => {
  const source = await seedThread({
    dataWorkspaceIds: [ids.wsA1],
    texts: ["Scoped ask", "Scoped answer"],
  });
  const newThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(newThreadId);

  await expectForked(
    forkThread.handler(
      forkContext({
        newThreadId,
        threadId: source.threadId,
        upToMessageId: messageAt(source, 0),
      }),
    ),
  );

  const [row] = await testDb
    .select({ dataWorkspaceIds: chatThreads.dataWorkspaceIds })
    .from(chatThreads)
    .where(eq(chatThreads.id, newThreadId))
    .limit(1);
  expect(row?.dataWorkspaceIds).toEqual([ids.wsA1]);

  // A session that lost the contributing matter can no longer read the fork,
  // exactly as it can no longer read the source.
  const narrowed = scopedFor({
    organizationId: ids.orgA,
    userId: ids.userA1,
    workspaceIds: [ids.wsA2],
  });
  const hidden = await narrowed((tx) =>
    tx
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.id, newThreadId))
      .limit(1),
  );
  expect(Result.isOk(hidden) && hidden.value).toEqual([]);
});

test("get-messages reports the fork's provenance and loses it when the parent goes", async () => {
  const source = await seedThread({ texts: ["Ask", "Answer"] });
  const newThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(newThreadId);

  await expectForked(
    forkThread.handler(
      forkContext({
        newThreadId,
        threadId: source.threadId,
        upToMessageId: messageAt(source, 0),
      }),
    ),
  );

  const readProvenance = async () => {
    const response = await getMessages.handler(
      asTestRaw<MessagesCtx>({
        getWorkspaceAccess: async () => await Promise.resolve(null),
        memberRole: { role: "owner" },
        orgAIConfig: null,
        params: { threadId: newThreadId },
        promptCachingEnabled: false,
        query: {},
        request: new Request("http://localhost/v1/chat/threads/messages"),
        safeDb,
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
      }),
    );
    if ("code" in response) {
      throw new TypeError(`get-messages failed: ${JSON.stringify(response)}`);
    }
    return response.forkProvenance;
  };

  expect(await readProvenance()).toEqual({
    threadId: source.threadId,
    title: "Termination clause",
    type: "parent",
    workspaceId: null,
  });

  await testDb.delete(chatThreads).where(eq(chatThreads.id, source.threadId));

  // SET NULL on the parent reference, while the boundary message id (which
  // carries no foreign key) survives as the "this is a fork" discriminator.
  const orphaned = await readFork(newThreadId);
  expect(orphaned?.parentThreadId).toBeNull();
  expect(orphaned?.forkedFromMessageId).toBe(messageAt(source, 0));
  expect(await readProvenance()).toEqual({ type: "parent-unavailable" });
});

test("a parent outside the reader's scope reports as unavailable, not by title", async () => {
  const source = await seedThread({ texts: ["Ask", "Answer"] });
  const newThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(newThreadId);

  await expectForked(
    forkThread.handler(
      forkContext({
        newThreadId,
        threadId: source.threadId,
        upToMessageId: messageAt(source, 0),
      }),
    ),
  );

  // After the fork, the owner narrows the parent onto a matter; a session
  // without that matter keeps the (still global) fork but must not learn the
  // parent's title through the provenance read.
  await testDb
    .update(chatThreads)
    .set({ dataWorkspaceIds: [ids.wsA1] })
    .where(eq(chatThreads.id, source.threadId));

  const narrowed = scopedFor({
    organizationId: ids.orgA,
    userId: ids.userA1,
    workspaceIds: [ids.wsA2],
  });
  const response = await getMessages.handler(
    asTestRaw<MessagesCtx>({
      getWorkspaceAccess: async () => await Promise.resolve(null),
      memberRole: { role: "owner" },
      orgAIConfig: null,
      params: { threadId: newThreadId },
      promptCachingEnabled: false,
      query: {},
      request: new Request("http://localhost/v1/chat/threads/messages"),
      safeDb: narrowed,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    }),
  );
  if ("code" in response) {
    throw new TypeError(`get-messages failed: ${JSON.stringify(response)}`);
  }
  expect(response.forkProvenance).toEqual({ type: "parent-unavailable" });
});

test("a thread that was never forked reports no provenance", async () => {
  const source = await seedThread({ texts: ["Ask"] });

  const response = await getMessages.handler(
    asTestRaw<MessagesCtx>({
      getWorkspaceAccess: async () => await Promise.resolve(null),
      memberRole: { role: "owner" },
      orgAIConfig: null,
      params: { threadId: source.threadId },
      promptCachingEnabled: false,
      query: {},
      request: new Request("http://localhost/v1/chat/threads/messages"),
      safeDb,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    }),
  );

  expect(response).toMatchObject({ forkProvenance: { type: "none" } });
});

test("a source attachment whose storage object is gone is skipped, not fatal", async () => {
  const source = await seedThread({
    texts: ["See the exhibit", "Reviewed"],
    withAttachment: true,
  });
  const attachment = source.attachment;
  if (attachment === null) {
    throw new TypeError("expected a seeded attachment");
  }
  // A live row whose bytes are gone: the shape a crash between an object
  // delete and its row delete leaves behind.
  fakeS3.objects.delete(`${BUCKET}/${attachment.s3Key}`);
  const newThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(newThreadId);

  await expectForked(
    forkThread.handler(
      forkContext({
        newThreadId,
        threadId: source.threadId,
        upToMessageId: messageAt(source, 1),
      }),
    ),
  );

  const copiedFiles = await testDb
    .select({ id: userFiles.id })
    .from(userFiles)
    .where(eq(userFiles.threadId, newThreadId))
    .limit(1);
  expect(copiedFiles).toHaveLength(0);
  // Nothing to share, so the reference is inherited as-is rather than pointed
  // at a copy that would have no bytes either.
  const copiedMessages = await readMessages(newThreadId);
  expect(copiedMessages).toHaveLength(2);
  expect(JSON.stringify(copiedMessages.at(0)?.content)).toContain(
    toUserFileUrl(attachment.fileId),
  );
});

test("a missing thumbnail copies the attachment without one", async () => {
  const source = await seedThread({
    texts: ["See the exhibit", "Reviewed"],
    withAttachment: true,
  });
  const attachment = source.attachment;
  if (attachment === null) {
    throw new TypeError("expected a seeded attachment");
  }
  fakeS3.objects.delete(`${BUCKET}/${attachment.thumbnailKey}`);
  const newThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(newThreadId);

  await expectForked(
    forkThread.handler(
      forkContext({
        newThreadId,
        threadId: source.threadId,
        upToMessageId: messageAt(source, 0),
      }),
    ),
  );

  const copiedFile = (
    await testDb
      .select({
        s3Key: userFiles.s3Key,
        thumbnailFileId: userFiles.thumbnailFileId,
      })
      .from(userFiles)
      .where(eq(userFiles.threadId, newThreadId))
      .limit(1)
  ).at(0);
  if (!copiedFile) {
    throw new TypeError("expected the fork to own a duplicated file row");
  }
  expect(copiedFile.thumbnailFileId).toBeNull();
  expect(fakeS3.objects.has(`${BUCKET}/${copiedFile.s3Key}`)).toBe(true);
});

test("copies a prefix longer than one insert batch", async () => {
  const texts = Array.from({ length: 450 }, (_, index) => `Turn ${index}`);
  const source = await seedThread({ texts });
  const newThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(newThreadId);

  await expectForked(
    forkThread.handler(
      forkContext({
        newThreadId,
        threadId: source.threadId,
        upToMessageId: messageAt(source, texts.length - 1),
      }),
    ),
  );

  const copied = await readMessages(newThreadId);
  expect(messageTexts(copied)).toEqual(texts);
});
