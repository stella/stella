import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  chatMessageFromPersisted,
  toPersistableChatMessage,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import {
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  insertChatTurnAcceptanceOnTx,
} from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnExecution } from "@/api/handlers/chat/chat-turn-persistence";
import {
  loadStoredTurnSettlement,
  persistStreamedTurn,
} from "@/api/handlers/chat/turns/settle";
import type { StreamedTurnSettlementContext } from "@/api/handlers/chat/turns/settle";
import type {
  ChatPart,
  PersistableTerminalAssistantMessage,
} from "@/api/handlers/chat/types";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withChatRunPings } from "@/api/lib/chat/chat-run-pings";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A turn that runs on the member's computer, settled by a task that did not
// start it: everything the send request held comes from the turn's rows.

let testDb: TestDatabase;
let ids: TestIds;
const seededThreads: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  if (seededThreads.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreads));
  }
  await releaseRlsFixture();
});

const safeDbOf = (userId: SafeId<"user">, workspaceId: SafeId<"workspace">) =>
  toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, [workspaceId], ids.orgA, userId),
    ),
  );

const noAudit: AuditRecorder = async () => {
  await Promise.resolve();
};

const READING = { content: "Reading the files.", type: "text" } as const;
const DONE = { content: "Done.", type: "text" } as const;
const HARNESS_CALL = {
  arguments: JSON.stringify({ command: "ls" }),
  id: "call-ls",
  input: { command: "ls" },
  name: "Bash",
  output: { stdout: "README.md" },
  state: "complete",
  type: "tool-call",
  metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "harness" },
} satisfies ChatPart;
const SERVER_CALL = {
  arguments: "{}",
  id: "call-listed",
  input: {},
  name: "list_templates",
  output: { templates: [] },
  state: "complete",
  type: "tool-call",
  metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
} satisfies ChatPart;

type SeededTurn = {
  checkpointMessageId: SafeId<"chatMessage">;
  execution: ChatTurnExecution;
  threadId: SafeId<"chatThread">;
};

/**
 * A running turn of user A1 whose thread holds the answer it continues, as a
 * continuation after a member's answer leaves it.
 */
const seedRunningTurnWithCheckpoint = async (): Promise<SeededTurn> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  const checkpointMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  seededThreads.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Settle from rows",
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  });
  await testDb.insert(chatMessages).values({
    id: userMessageId,
    threadId,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
    role: "user",
    content: toPersistedChatMessageContentV3({
      data: [{ content: "List the files", type: "text" }],
    }),
  });
  const acceptance = createChatTurnAcceptance({
    source: { type: "member" },
    organizationId: ids.orgA,
    threadId,
    userId: ids.userA1,
    userMessageId,
    workspaceId: ids.wsA1,
  });
  const safeDb = safeDbOf(ids.userA1, ids.wsA1);
  const inserted = await withChatRunPings(
    async (pings) =>
      await safeDb(
        async (tx) =>
          await insertChatTurnAcceptanceOnTx({ pings, acceptance, tx }),
      ),
  );
  if (Result.isError(inserted)) {
    panic("Could not seed chat turn", inserted.error);
  }
  const claimed = await claimChatTurnForExecution({
    acceptedTurnId: acceptance.id,
    incomingMessageId: userMessageId,
    incomingMessageRole: "user",
    organizationId: ids.orgA,
    safeDb,
    threadId,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  });
  if (Result.isError(claimed)) {
    panic("Could not claim seeded chat turn", claimed.error);
  }
  await testDb.insert(chatMessages).values({
    id: checkpointMessageId,
    threadId,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
    role: "assistant",
    content: toPersistedChatMessageContentV3({ data: [READING] }),
  });
  return {
    checkpointMessageId,
    execution: claimed.value ?? panic("Expected the seeded turn claimed"),
    threadId,
  };
};

const memberOf = (userId: SafeId<"user">, safeDb: SafeDb) => ({
  getActiveWorkspaceIds: async () => await Promise.resolve([ids.wsA1]),
  recordAuditEvent: noAudit,
  safeDb,
  user: { id: userId, email: `${userId}@example.test` },
});

const load = async (
  seeded: SeededTurn,
  member = memberOf(ids.userA1, safeDbOf(ids.userA1, ids.wsA1)),
) => {
  const loaded = await loadStoredTurnSettlement({
    checkpointMessageId: seeded.checkpointMessageId,
    createRefRegistry: createChatRefRegistry,
    execution: seeded.execution,
    indexThread: async () => {},
    member,
    threadId: seeded.threadId,
  });
  if (Result.isError(loaded)) {
    panic("Could not read the stored turn", loaded.error);
  }
  return loaded.value;
};

const loadedContext = async (
  seeded: SeededTurn,
): Promise<StreamedTurnSettlementContext> => {
  const loaded = await load(seeded);
  if (loaded.type !== "loaded") {
    return panic(`Expected the stored turn loaded, got ${loaded.type}`);
  }
  return loaded.context;
};

const completedAnswer = (
  seeded: SeededTurn,
  parts: ChatPart[],
): PersistableTerminalAssistantMessage => ({
  ...toPersistableChatMessage({
    id: seeded.checkpointMessageId,
    parts,
    role: "assistant",
  }),
  metadata: { turnOutcome: { type: "completed" } },
  role: "assistant",
});

const readTurn = async (turnId: SafeId<"chatTurn">) =>
  (await testDb.query.chatTurns.findFirst({ where: { id: { eq: turnId } } })) ??
  panic("Expected the turn row");

const readMessage = async (messageId: SafeId<"chatMessage">) =>
  chatMessageFromPersisted(
    (await testDb.query.chatMessages.findFirst({
      where: { id: { eq: messageId } },
      columns: { content: true, id: true, role: true },
    })) ?? panic("Expected the message row"),
  );

describe("a turn settled from its stored rows", () => {
  test("continues the stored answer as a harness's, inside the member's matters", async () => {
    const seeded = await seedRunningTurnWithCheckpoint();
    const context = await loadedContext(seeded);

    expect(context.turn.owningAssistantMessage?.id).toBe(
      seeded.checkpointMessageId,
    );
    expect(context.turn.owningAssistantMessage?.parts).toEqual([READING]);
    expect(context.turn.workspaceId).toBe(ids.wsA1);
    expect(context.turn.sendMode).toBeNull();
    expect(context.history.existingIds.has(seeded.checkpointMessageId)).toBe(
      true,
    );
    expect(context.toolCalls.ownership).toBe("harness");
    // No pins: an agent's tools reach every matter the member can use.
    expect([...context.refs.opaqueReadWorkspaceIds]).toEqual([ids.wsA1]);
  });

  test("stores the run's answer on the stored one and completes the turn", async () => {
    const seeded = await seedRunningTurnWithCheckpoint();
    const context = await loadedContext(seeded);

    const stored = await persistStreamedTurn({
      context,
      event: {
        outcome: { type: "completed" },
        responseMessage: completedAnswer(seeded, [READING, HARNESS_CALL, DONE]),
      },
    });

    expect(stored.isOk() ? stored.value.settlement : stored.error).toEqual({
      type: "stored",
      outcome: { type: "completed" },
    });
    const turn = await readTurn(seeded.execution.id);
    expect(turn.status).toBe("completed");
    expect(turn.assistantMessageId).toBe(seeded.checkpointMessageId);
    expect(turn.executionId).toBeNull();
    const message = await readMessage(seeded.checkpointMessageId);
    expect(
      message.parts.flatMap((part) =>
        part.type === "text" ? [part.content] : [],
      ),
    ).toEqual([READING.content, DONE.content]);
    expect(
      message.parts.some(
        (part) => part.type === "tool-call" && part.id === HARNESS_CALL.id,
      ),
    ).toBe(true);
  });

  test("refuses a call the computer did not run, and leaves the turn running", async () => {
    const seeded = await seedRunningTurnWithCheckpoint();
    const context = await loadedContext(seeded);

    const stored = await persistStreamedTurn({
      context,
      event: {
        outcome: { type: "completed" },
        responseMessage: completedAnswer(seeded, [READING, SERVER_CALL]),
      },
    });

    expect(stored.isErr() ? stored.error.code : "stored").toBe("persistence");
    const turn = await readTurn(seeded.execution.id);
    expect(turn.status).toBe("running");
    expect(turn.executionId).toBe(seeded.execution.executionId);
  });

  test("finds nothing to continue without the stored answer", async () => {
    const seeded = await seedRunningTurnWithCheckpoint();

    expect(
      (
        await load({
          ...seeded,
          checkpointMessageId: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
        })
      ).type,
    ).toBe("checkpoint-missing");
  });

  test("reads no thread the member does not own", async () => {
    const seeded = await seedRunningTurnWithCheckpoint();

    expect(
      (await load(seeded, memberOf(ids.userA2, safeDbOf(ids.userA2, ids.wsA1))))
        .type,
    ).toBe("thread-unavailable");
  });
});
