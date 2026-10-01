import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads, userFiles } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  createChatAttachmentPart,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import type { ChatMention } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createUserFileKey } from "@/api/lib/files/utils";
import { toUserFileUrl } from "@/api/lib/user-files/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import getThreads from "./list";
import { CHAT_THREAD_CONTEXT_PREVIEW_LIMIT } from "./list-context";

// The history list's context preview: which matters and files each thread
// drew on, resolved through the caller's RLS scope, capped per thread with a
// total count, and read for the whole page at once.

type ThreadsCtx = Parameters<typeof getThreads.handler>[0];

const PDF_MIME_TYPE = "application/pdf";

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
    ),
  );
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

const seedThread = async ({
  attachmentNames = [],
  contextMatterIds = [],
  mentions = [],
  title,
  workspaceId = null,
}: {
  attachmentNames?: string[];
  contextMatterIds?: SafeId<"workspace">[];
  mentions?: ChatMention[];
  title: string;
  workspaceId?: SafeId<"workspace"> | null;
}): Promise<SafeId<"chatThread">> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    contextMatterIds,
    id: threadId,
    organizationId: ids.orgA,
    title,
    titleSource: "user",
    userId: ids.userA1,
    workspaceId,
  });

  const attachmentParts = [];
  for (const [index, fileName] of attachmentNames.entries()) {
    const fileId = toSafeId<"userFile">(Bun.randomUUIDv7());
    await testDb.insert(userFiles).values({
      createdAt: new Date(Date.parse("2026-09-01T09:00:00.000Z") + index),
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
    attachmentParts.push(
      createChatAttachmentPart({
        filename: fileName,
        mimeType: PDF_MIME_TYPE,
        url: toUserFileUrl(fileId),
      }),
    );
  }

  await testDb.insert(chatMessages).values({
    content: toPersistedChatMessageContentV3({
      data: [{ content: "Summarise these.", type: "text" }, ...attachmentParts],
      ...(mentions.length > 0 ? { metadata: { mentions: { mentions } } } : {}),
    }),
    id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
    role: "user",
    threadId,
    userId: ids.userA1,
    workspaceId,
  });
  return threadId;
};

const listThreads = async (search?: string) => {
  const listed = await getThreads.handler(
    asTestRaw<ThreadsCtx>({
      memberRole: { role: "owner" },
      query: { limit: 100, ...(search === undefined ? {} : { search }) },
      request: new Request("http://localhost/v1/chat/threads"),
      safeDb,
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
});
