import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  chatMessages,
  chatThreads,
  userFiles,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  createChatAttachmentPart,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import type { ChatMention } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createUserFileKey } from "@/api/lib/files/utils";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { toUserFileUrl } from "@/api/lib/user-files/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import getThreads, { createGetThreads } from "./list";
import {
  CHAT_THREAD_CONTEXT_MATTER_SCAN_LIMIT,
  CHAT_THREAD_CONTEXT_PREVIEW_LIMIT,
  readChatThreadAttachedFiles,
} from "./list-context";

// The history list's context preview: which matters and files each thread
// drew on, resolved through the caller's RLS scope, capped per thread with a
// total count, and read for the whole page at once.

type ThreadsCtx = Parameters<typeof getThreads.handler>[0];

const PDF_MIME_TYPE = "application/pdf";

let testDb: TestDatabase;
let ids: TestIds;
const seededThreadIds: SafeId<"chatThread">[] = [];
const seededWorkspaceIds: SafeId<"workspace">[] = [];

const scopedTo = (workspaceIds: SafeId<"workspace">[]): SafeDb =>
  toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, workspaceIds, ids.orgA, ids.userA1),
    ),
  );

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
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
  if (seededWorkspaceIds.length > 0) {
    await testDb
      .delete(workspaces)
      .where(inArray(workspaces.id, seededWorkspaceIds));
  }
  await releaseRlsFixture();
});

const entityMention = (
  entityId: SafeId<"entity">,
  workspaceId: SafeId<"workspace">,
): ChatMention => ({
  category: "entity",
  id: entityId,
  label: "mentioned file",
  resource: resourceRef({ type: RESOURCE_TYPE.ENTITY, id: entityId }),
  workspaceId,
});

const matterMention = (workspaceId: SafeId<"workspace">): ChatMention => ({
  category: "workspace",
  id: workspaceId,
  label: "mentioned matter",
  resource: resourceRef({ type: RESOURCE_TYPE.WORKSPACE, id: workspaceId }),
});

const MESSAGE_TIME_BASE = Date.parse("2026-09-01T09:00:00.000Z");

const insertUpload = async ({
  fileName,
  threadId,
}: {
  fileName: string;
  threadId: SafeId<"chatThread">;
}): Promise<SafeId<"userFile">> => {
  const fileId = toSafeId<"userFile">(Bun.randomUUIDv7());
  await testDb.insert(userFiles).values({
    fileName,
    id: fileId,
    mimeType: PDF_MIME_TYPE,
    s3Key: createUserFileKey({
      fileId,
      mimeType: PDF_MIME_TYPE,
      userId: ids.userA1,
    }),
    sha256Hex: "b".repeat(64),
    sizeBytes: 12,
    threadId,
    userId: ids.userA1,
  });
  return fileId;
};

const seedThread = async ({
  attachmentNames = [],
  contextMatterIds = [],
  dataWorkspaceIds = [],
  legacyMentions = [],
  mentions = [],
  orphanUploadNames = [],
  subjectDecisionId = null,
  title,
  workspaceId = null,
}: {
  /** Each upload is sent in its own message, oldest first. */
  attachmentNames?: string[];
  contextMatterIds?: SafeId<"workspace">[];
  dataWorkspaceIds?: SafeId<"workspace">[];
  /** Mentions stored the version-1 way, as a data-stella-mentions part. */
  legacyMentions?: ChatMention[];
  mentions?: ChatMention[];
  /** Uploads whose message no longer exists (edited away or truncated). */
  orphanUploadNames?: string[];
  subjectDecisionId?: SafeId<"caseLawDecision"> | null;
  title: string;
  workspaceId?: SafeId<"workspace"> | null;
}): Promise<SafeId<"chatThread">> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    contextMatterIds,
    dataWorkspaceIds,
    id: threadId,
    organizationId: ids.orgA,
    subjectDecisionId,
    title,
    titleSource: "user",
    userId: ids.userA1,
    workspaceId,
  });

  const message = (index: number) => ({
    createdAt: new Date(MESSAGE_TIME_BASE + index),
    id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
    role: "user" as const,
    threadId,
    userId: ids.userA1,
    workspaceId,
  });

  for (const fileName of orphanUploadNames) {
    await insertUpload({ fileName, threadId });
  }

  for (const [index, fileName] of attachmentNames.entries()) {
    const fileId = await insertUpload({ fileName, threadId });
    await testDb.insert(chatMessages).values({
      ...message(index),
      content: toPersistedChatMessageContentV3({
        data: [
          { content: "See attached.", type: "text" },
          createChatAttachmentPart({
            filename: fileName,
            mimeType: PDF_MIME_TYPE,
            url: toUserFileUrl(fileId),
          }),
        ],
      }),
    });
  }

  if (legacyMentions.length > 0) {
    await testDb.insert(chatMessages).values({
      ...message(attachmentNames.length),
      content: asTestRaw<typeof chatMessages.$inferInsert.content>({
        data: [
          { text: "Compare these.", type: "text" },
          { data: { mentions: legacyMentions }, type: "data-stella-mentions" },
        ],
        version: 1,
      }),
    });
  }

  await testDb.insert(chatMessages).values({
    ...message(attachmentNames.length + 1),
    content: toPersistedChatMessageContentV3({
      data: [{ content: "Summarise these.", type: "text" }],
      ...(mentions.length > 0 ? { metadata: { mentions: { mentions } } } : {}),
    }),
  });
  return threadId;
};

const listThreads = async (
  search?: string,
  workspaceIds: SafeId<"workspace">[] = [ids.wsA1, ids.wsA2],
  handler: typeof getThreads = getThreads,
) => {
  const listed = await handler.handler(
    asTestRaw<ThreadsCtx>({
      memberRole: sessionMemberRole("owner"),
      query: { limit: 100, ...(search === undefined ? {} : { search }) },
      request: new Request("http://localhost/v1/chat/threads"),
      safeDb: scopedTo(workspaceIds),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    }),
  );
  if ("code" in listed) {
    throw new TypeError(`get-threads failed: ${JSON.stringify(listed)}`);
  }
  return listed;
};

const findThread = (
  listed: Awaited<ReturnType<typeof listThreads>>,
  threadId: string,
) =>
  [
    ...listed.global,
    ...listed.workspaces.flatMap((group) => group.threads),
  ].find((thread) => thread.id === threadId);

describe("chat thread list context", () => {
  test("names pinned and mentioned matters and files, never inaccessible ones", async () => {
    const threadId = await seedThread({
      attachmentNames: ["exhibit-a.pdf"],
      // wsB1 belongs to another organization: it is neither shown nor counted.
      contextMatterIds: [ids.wsA2, ids.wsB1],
      mentions: [
        entityMention(ids.entityA1, ids.wsA1),
        entityMention(ids.entityB1, ids.wsB1),
        matterMention(ids.wsA1),
      ],
      title: "Context: global",
    });

    const thread = findThread(await listThreads(), threadId);

    expect(thread?.context.matters.map((matter) => matter.id)).toEqual([
      ids.wsA2,
      ids.wsA1,
    ]);
    expect(thread?.context.matterCount).toBe(2);
    expect(
      thread?.context.files.map((file) => ({
        kind: file.kind,
        mimeType: file.mimeType,
        name: file.name,
      })),
    ).toEqual(
      expect.arrayContaining([
        { kind: "document", mimeType: null, name: "entityA1" },
        { kind: "document", mimeType: PDF_MIME_TYPE, name: "exhibit-a.pdf" },
      ]),
    );
    expect(thread?.context.files.map((file) => file.id)).not.toContain(
      ids.entityB1,
    );
    expect(thread?.context.fileCount).toBe(2);
  });

  test("puts the matter a thread lives in first", async () => {
    const threadId = await seedThread({
      contextMatterIds: [ids.wsA2],
      title: "Context: matter",
      workspaceId: ids.wsA1,
    });

    const thread = findThread(await listThreads(), threadId);

    expect(thread?.context.matters.map((matter) => matter.name)).toEqual([
      "WS A1",
      "WS A2",
    ]);
    expect(thread?.context.files).toEqual([]);
    expect(thread?.context.fileCount).toBe(0);
  });

  test("caps the preview and still counts every file it found", async () => {
    const fileTotal = CHAT_THREAD_CONTEXT_PREVIEW_LIMIT + 3;
    const threadId = await seedThread({
      attachmentNames: Array.from(
        { length: fileTotal },
        (_, index) => `exhibit-${index}.pdf`,
      ),
      title: "Context: many files",
    });

    const thread = findThread(await listThreads(), threadId);

    expect(thread?.context.files).toHaveLength(
      CHAT_THREAD_CONTEXT_PREVIEW_LIMIT,
    );
    expect(thread?.context.fileCount).toBe(fileTotal);
    // Newest first.
    expect(thread?.context.files.at(0)?.name).toBe(
      `exhibit-${fileTotal - 1}.pdf`,
    );
  });

  test("a thread without any context carries an empty preview", async () => {
    const threadId = await seedThread({ title: "Context: none" });

    const thread = findThread(await listThreads(), threadId);

    expect(thread?.context).toEqual({
      fileCount: 0,
      files: [],
      matterCount: 0,
      matters: [],
    });
  });

  test("search matches the name of a matter pinned to a global thread", async () => {
    const threadId = await seedThread({
      contextMatterIds: [ids.wsA2],
      title: "Context: pinned search",
    });
    const unrelatedId = await seedThread({ title: "Context: unrelated" });

    const listed = await listThreads("WS A2");

    expect(findThread(listed, threadId)).toBeDefined();
    expect(findThread(listed, unrelatedId)).toBeUndefined();
  });

  test("reads mentions stored by version-1 messages", async () => {
    const threadId = await seedThread({
      legacyMentions: [
        entityMention(ids.entityA2, ids.wsA2),
        matterMention(ids.wsA2),
      ],
      title: "Context: legacy mentions",
    });

    const thread = findThread(await listThreads(), threadId);

    expect(thread?.context.matters.map((matter) => matter.id)).toEqual([
      ids.wsA2,
    ]);
    expect(thread?.context.files.map((file) => file.id)).toEqual([
      ids.entityA2,
    ]);
  });

  test("leaves out uploads no surviving message attaches", async () => {
    const threadId = await seedThread({
      attachmentNames: ["kept.pdf"],
      orphanUploadNames: ["edited-away.pdf"],
      title: "Context: edited upload",
    });

    const thread = findThread(await listThreads(), threadId);

    expect(thread?.context.files.map((file) => file.name)).toEqual([
      "kept.pdf",
    ]);
    expect(thread?.context.fileCount).toBe(1);
  });

  test("files carry how they open: uploads by id, documents with their matter", async () => {
    const threadId = await seedThread({
      attachmentNames: ["exhibit-b.pdf"],
      mentions: [entityMention(ids.entityA1, ids.wsA1)],
      title: "Context: file types",
    });

    const thread = findThread(await listThreads(), threadId);

    expect(thread?.context.files).toEqual(
      expect.arrayContaining([
        {
          id: ids.entityA1,
          kind: "document",
          matterId: ids.wsA1,
          mimeType: null,
          name: "entityA1",
          type: "entity",
        },
        expect.objectContaining({
          kind: "document",
          mimeType: PDF_MIME_TYPE,
          name: "exhibit-b.pdf",
          type: "upload",
        }),
      ]),
    );
  });

  test("reads mentions the composer stores only as links in the text", async () => {
    const threadId = await seedThread({ title: "Context: linked mentions" });
    await testDb.insert(chatMessages).values({
      content: toPersistedChatMessageContentV3({
        data: [
          {
            content:
              `Compare [entityA2](#stella-entity=${ids.wsA2}:${ids.entityA2}) ` +
              `in [WS A2](#stella-workspace=${ids.wsA2}) with ` +
              `[foreign](#stella-entity=${ids.wsB1}:${ids.entityB1}).`,
            type: "text",
          },
        ],
      }),
      createdAt: new Date(MESSAGE_TIME_BASE + 10),
      id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
      role: "user",
      threadId,
      userId: ids.userA1,
      workspaceId: null,
    });

    const thread = findThread(await listThreads(), threadId);

    expect(thread?.context.files.map((file) => file.id)).toEqual([
      ids.entityA2,
    ]);
    expect(thread?.context.fileCount).toBe(1);
    expect(thread?.context.matters.map((matter) => matter.id)).toEqual([
      ids.wsA2,
    ]);
  });

  test("does not count an upload another thread owns", async () => {
    const ownerId = await seedThread({
      attachmentNames: ["owner.pdf"],
      title: "Context: upload owner",
    });
    const borrowerId = await seedThread({ title: "Context: upload borrower" });
    const foreignFileId = await insertUpload({
      fileName: "foreign.pdf",
      threadId: ownerId,
    });
    // A message in one thread pointing at another thread's upload.
    await testDb.insert(chatMessages).values({
      content: toPersistedChatMessageContentV3({
        data: [
          { content: "See this.", type: "text" },
          createChatAttachmentPart({
            filename: "foreign.pdf",
            mimeType: PDF_MIME_TYPE,
            url: toUserFileUrl(foreignFileId),
          }),
        ],
      }),
      createdAt: new Date(MESSAGE_TIME_BASE + 10),
      id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
      role: "user",
      threadId: borrowerId,
      userId: ids.userA1,
      workspaceId: null,
    });

    const listed = await listThreads();

    expect(findThread(listed, borrowerId)?.context.fileCount).toBe(0);
    expect(findThread(listed, borrowerId)?.context.files).toEqual([]);
    // The owner's own messages never attached it either.
    expect(
      findThread(listed, ownerId)?.context.files.map((file) => file.name),
    ).toEqual(["owner.pdf"]);
  });

  test("search matches a matter whose data a thread embedded", async () => {
    const threadId = await seedThread({
      dataWorkspaceIds: [ids.wsA1],
      title: "Context: embedded search",
    });

    expect(findThread(await listThreads("WS A1"), threadId)).toBeDefined();
  });

  test("search keeps a pinned-matter match however many matters match", async () => {
    const matchingCount = CHAT_THREAD_CONTEXT_MATTER_SCAN_LIMIT + 5;
    const matterIds = Array.from({ length: matchingCount }, () =>
      toSafeId<"workspace">(Bun.randomUUIDv7()),
    );
    seededWorkspaceIds.push(...matterIds);
    await testDb.insert(workspaces).values(
      matterIds.map((id, index) => ({
        clientId: ids.contactA,
        id,
        name: `Zeta matter ${index}`,
        organizationId: ids.orgA,
        reference: `ZETA-${id}`,
      })),
    );
    const pinnedId = matterIds.at(-1) ?? panic("no matter seeded");
    const threadId = await seedThread({
      contextMatterIds: [pinnedId],
      title: "Context: many matching matters",
    });

    const listed = await listThreads("Zeta matter", [
      ids.wsA1,
      ids.wsA2,
      ...matterIds,
    ]);

    expect(findThread(listed, threadId)).toBeDefined();
  });
});

// The open thread's header lists every file the thread attached, by the same
// definition as the history row, past the list's preview cap.
describe("open chat thread attached files", () => {
  const readAttached = async (threadId: SafeId<"chatThread">) => {
    const result = await scopedTo([ids.wsA1, ids.wsA2])(
      async (tx) => await readChatThreadAttachedFiles({ threadId, tx }),
    );
    if (Result.isError(result)) {
      throw result.error;
    }
    return result.value;
  };

  test("a thread without attachments reads as none", async () => {
    const threadId = await seedThread({
      mentions: [matterMention(ids.wsA1)],
      title: "Attached: none",
    });

    expect(await readAttached(threadId)).toEqual({ fileCount: 0, files: [] });
  });

  test("names every attached file past the list preview, newest first", async () => {
    const fileTotal = CHAT_THREAD_CONTEXT_PREVIEW_LIMIT + 3;
    const threadId = await seedThread({
      attachmentNames: Array.from(
        { length: fileTotal },
        (_, index) => `exhibit-${index}.pdf`,
      ),
      title: "Attached: many files",
    });

    const attached = await readAttached(threadId);

    expect(attached.fileCount).toBe(fileTotal);
    expect(attached.files.map((file) => file.name)).toEqual(
      Array.from(
        { length: fileTotal },
        (_, index) => `exhibit-${fileTotal - 1 - index}.pdf`,
      ),
    );
  });

  test("leaves out documents in another organization", async () => {
    const threadId = await seedThread({
      mentions: [
        entityMention(ids.entityA1, ids.wsA1),
        entityMention(ids.entityB1, ids.wsB1),
      ],
      title: "Attached: cross-organization mention",
    });

    const attached = await readAttached(threadId);

    expect(attached.files.map((file) => file.id)).toEqual([ids.entityA1]);
    expect(attached.fileCount).toBe(1);
  });
});

describe("chat thread list decision badges", () => {
  test("a failed badge read keeps the history and marks only decision chats", async () => {
    const decisionThreadId = await seedThread({
      subjectDecisionId: toSafeId<"caseLawDecision">(Bun.randomUUIDv7()),
      title: "Decision chat",
    });
    const plainThreadId = await seedThread({ title: "Plain chat" });
    const failingBadges = createGetThreads({
      readDecisionBadges: () =>
        Promise.resolve(
          Result.err(
            new HandlerError({ status: 500, message: "corpus unavailable" }),
          ),
        ),
    });

    const listed = await listThreads(undefined, undefined, failingBadges);

    expect(findThread(listed, decisionThreadId)?.decision).toEqual({
      type: "unavailable",
    });
    expect(findThread(listed, plainThreadId)?.decision).toBeNull();
  });
});
