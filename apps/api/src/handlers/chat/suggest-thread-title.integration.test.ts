import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { CHAT_TITLE_SOURCE, chatMessages, chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const generateTextMock = mock(async () => '"Title: Drafting an NDA"');
// SAFETY: The test fake ignores request details and returns a fixture title.
const generateTextForTest =
  generateTextMock as typeof generateTanStackTextForRole;
const { createSuggestThreadTitle } = await import("./suggest-thread-title");
const suggestThreadTitle = createSuggestThreadTitle({
  generateTextForRole: generateTextForTest,
});
type SuggestCtx = Parameters<typeof suggestThreadTitle.handler>[0];

const orgAIConfig = {
  providers: [{ provider: "openai", apiKey: "test-api-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-5.4-mini" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
  },
} satisfies OrgAIConfig;

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
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

const SEEDED_TITLE = "New chat";

const seedThread = async ({
  dataWorkspaceIds = [],
  messageTexts = [],
  usedAnonymization = false,
  userId,
  workspaceId = null,
}: {
  dataWorkspaceIds?: SafeId<"workspace">[];
  messageTexts?: string[];
  usedAnonymization?: boolean;
  userId?: SafeId<"user">;
  workspaceId?: SafeId<"workspace"> | null;
}): Promise<SafeId<"chatThread">> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  const ownerId = userId ?? ids.userA1;
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    dataWorkspaceIds,
    title: SEEDED_TITLE,
    usedAnonymization,
    userId: ownerId,
    workspaceId,
  });
  if (messageTexts.length > 0) {
    await testDb.insert(chatMessages).values(
      messageTexts.map((text, index) => ({
        content: toChatMessageContent({
          data: [{ content: text, type: "text" }],
          version: 2,
        }),
        createdAt: new Date(Date.parse("2026-08-03T12:00:00.000Z") + index),
        id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        threadId,
        userId: ownerId,
        workspaceId,
      })),
    );
  }
  return threadId;
};

const createContext = ({
  threadId,
  workspaceId,
}: {
  threadId: SafeId<"chatThread">;
  workspaceId?: SafeId<"workspace">;
}): SuggestCtx =>
  asTestRaw<SuggestCtx>({
    getWorkspaceAccess: async (id: SafeId<"workspace">) =>
      id === ids.wsA1 ? { id: ids.wsA1, status: "active" } : null,
    memberRole: { role: "owner" },
    orgAIConfig,
    params: { threadId },
    promptCachingEnabled: false,
    query: workspaceId ? { workspaceId } : {},
    request: new Request("http://localhost/v1/chat/threads/title/suggest"),
    safeDb,
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
  });

const readTitleState = async (threadId: SafeId<"chatThread">) => {
  const [row] = await testDb
    .select({ title: chatThreads.title, titleSource: chatThreads.titleSource })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!row) {
    throw new TypeError(`thread ${threadId} not found`);
  }
  return row;
};

describe("suggest thread title", () => {
  test("defers AI availability and usage checks until after thread gates", () => {
    expect("requiresUsage" in suggestThreadTitle.config).toBe(false);
  });

  test("returns a cleaned title and writes nothing", async () => {
    const threadId = await seedThread({
      messageTexts: ["Draft an NDA for Acme", "Here is a draft NDA…"],
    });

    generateTextMock.mockClear();
    const result = await suggestThreadTitle.handler(
      createContext({ threadId }),
    );

    expect(result).toEqual({ title: "Drafting an NDA" });
    expect(generateTextMock).toHaveBeenCalledTimes(1);

    // Read-only contract: the suggestion must leave the persisted title and
    // its source untouched on the happy path.
    expect(await readTitleState(threadId)).toEqual({
      title: SEEDED_TITLE,
      titleSource: CHAT_TITLE_SOURCE.DEFAULT,
    });
  });

  test("passes the persisted data scope to the model-ingress boundary", async () => {
    const workspaceId = ids.wsA1;
    const threadId = await seedThread({
      dataWorkspaceIds: [workspaceId],
      messageTexts: [
        `Draft a title for workspace ${workspaceId}`,
        "Here is a draft.",
      ],
    });

    generateTextMock.mockClear();
    const result = await suggestThreadTitle.handler(
      createContext({ threadId }),
    );

    expect(result).toEqual({ title: "Drafting an NDA" });
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(workspaceId),
        tenantWorkspaceIds: [workspaceId],
      }),
    );
  });

  test("refuses an anonymized thread with 403 and spends no model call", async () => {
    const threadId = await seedThread({
      messageTexts: ["Anonymized ask", "Anonymized answer"],
      usedAnonymization: true,
    });

    generateTextMock.mockClear();
    const result = await suggestThreadTitle.handler(
      createContext({ threadId }),
    );

    expect(result).toMatchObject({ code: 403 });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  test("rejects a message-less thread with 409", async () => {
    const threadId = await seedThread({});

    generateTextMock.mockClear();
    const result = await suggestThreadTitle.handler(
      createContext({ threadId }),
    );

    expect(result).toMatchObject({ code: 409 });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  test("hides another user's thread behind 404", async () => {
    const threadId = await seedThread({
      messageTexts: ["Someone else's question"],
      userId: ids.userA2,
    });

    const result = await suggestThreadTitle.handler(
      createContext({ threadId }),
    );

    expect(result).toMatchObject({ code: 404 });
  });

  test("rejects a workspace thread requested through the global scope", async () => {
    const threadId = await seedThread({
      messageTexts: ["Workspace question", "Workspace answer"],
      workspaceId: ids.wsA1,
    });

    const result = await suggestThreadTitle.handler(
      createContext({ threadId }),
    );

    expect(result).toMatchObject({ code: 400 });
  });

  test("resolves a workspace thread through its own scope", async () => {
    const threadId = await seedThread({
      messageTexts: ["Workspace question", "Workspace answer"],
      workspaceId: ids.wsA1,
    });

    generateTextMock.mockClear();
    const result = await suggestThreadTitle.handler(
      createContext({ threadId, workspaceId: ids.wsA1 }),
    );

    expect(result).toEqual({ title: "Drafting an NDA" });
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantWorkspaceIds: [ids.wsA1] }),
    );
  });
});
