import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import type { ChatSendRequest } from "@stll/api-contract/chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import getMessages from "@/api/handlers/chat/messages/list";
import {
  loadThread,
  readThreadValidationState,
} from "@/api/handlers/chat/send-message-thread";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

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
      createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
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

const createThread = async (
  threadId: SafeId<"chatThread">,
  initialActiveSkill: ChatSendRequest["activeSkill"],
) =>
  await loadThread({
    initialActiveSkill,
    initialContextMatterIds: [],
    initialDataWorkspaceIds: [],
    organizationId: ids.orgA,
    recordAuditEvent: async () => undefined,
    safeDb,
    threadId,
    title: "Durable skill test",
    userId: ids.userA1,
    workspaceId: null,
  });

type MessagesCtx = Parameters<typeof getMessages.handler>[0];

const readThread = async (threadId: SafeId<"chatThread">) =>
  await getMessages.handler(
    asTestRaw<MessagesCtx>({
      getWorkspaceAccess: async () => null,
      memberRole: sessionMemberRole("owner"),
      orgAIConfig: null,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      managedAIResidency: "eu",
      params: { threadId },
      promptCachingEnabled: false,
      query: {},
      request: new Request("http://localhost/v1/chat/threads/messages"),
      safeDb,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    }),
  );

const BUILDER_SKILL = { skillName: "playbook-builder" };

describe("a thread keeps the skill it started with", () => {
  test.each([
    { name: "built-in builder", skill: BUILDER_SKILL },
    { name: "ordinary chat", skill: undefined },
  ])(
    "round-trips the $name skill through the thread API",
    async ({ skill }) => {
      const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
      seededThreadIds.push(threadId);
      const created = await createThread(threadId, skill);
      expect(Result.isOk(created)).toBe(true);
      if (Result.isError(created)) {
        throw new TypeError(`Thread creation failed: ${created.error.message}`);
      }
      expect(created.value.type).toBe("created");

      const response = await readThread(threadId);
      expect(response).toMatchObject({
        activeSkill: skill ?? null,
        threadExists: true,
      });

      const validation = await readThreadValidationState({
        messageId: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
        organizationId: ids.orgA,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: null,
      });
      expect(Result.isOk(validation)).toBe(true);
      if (Result.isError(validation)) {
        throw new TypeError(
          `Thread validation failed: ${validation.error.message}`,
        );
      }
      expect(validation.value.activeSkill).toEqual(skill);
    },
  );

  test("an existing builder keeps its stored skill when a later request carries another skill", async () => {
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    const created = await createThread(threadId, BUILDER_SKILL);
    expect(Result.isOk(created)).toBe(true);
    if (Result.isError(created)) {
      throw new TypeError(`Thread creation failed: ${created.error.message}`);
    }

    const reopened = await createThread(threadId, { skillName: "review" });
    expect(Result.isOk(reopened)).toBe(true);
    if (Result.isError(reopened)) {
      throw new TypeError(`Thread reopening failed: ${reopened.error.message}`);
    }
    expect(reopened.value.type).toBe("existing");

    const validation = await readThreadValidationState({
      initialActiveSkill: { skillName: "review" },
      messageId: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
      organizationId: ids.orgA,
      safeDb,
      threadId,
      userId: ids.userA1,
      workspaceId: null,
    });
    expect(Result.isOk(validation)).toBe(true);
    if (Result.isError(validation)) {
      throw new TypeError(
        `Thread validation failed: ${validation.error.message}`,
      );
    }
    expect(validation.value.activeSkill).toEqual(BUILDER_SKILL);
    expect(await readThread(threadId)).toMatchObject({
      activeSkill: BUILDER_SKILL,
      threadExists: true,
    });
  });
});
