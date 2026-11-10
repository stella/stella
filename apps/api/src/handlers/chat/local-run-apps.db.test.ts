import { EventType } from "@tanstack/ai";
import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { harnessEventsToChunks } from "@stll/agent-engine";
import type { HarnessEvent } from "@stll/agent-engine";
import {
  DESKTOP_RUNNER_DESKTOP_MESSAGE,
  DESKTOP_RUNNER_PROTOCOL,
} from "@stll/api-contract/desktop-runner";
import {
  readStellaMcpAppCall,
  STELLA_MCP_APP_MIME_TYPE,
  stellaMcpAppPartSchema,
} from "@stll/api-contract/stella-mcp-app";
import { CASE_LAW_RESULTS_RESOURCE_URI } from "@stll/mcp-apps/resource-uri";
import { createTestClock } from "@stll/test-kit";

import { desktopRunnerRuns, desktopRunners } from "@/api/db/schema";
import {
  classifyChatPartForPersistence,
  normalizePersistedChatMessageContent,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import {
  createLocalChatRun,
  type LocalRunContext,
} from "@/api/handlers/chat/local-run-chunks";
import { createVisualResourceOrigin } from "@/api/handlers/visual-sandbox/resource-origin";
import { createSafeId } from "@/api/lib/branded-types";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import {
  appCallArgumentsHash,
  pairAppCall,
  recordAppCall,
} from "@/api/lib/desktop-runner/app-calls";
import { createLocalRunBell } from "@/api/lib/desktop-runner/doorbell";
import type { DesktopRunnerDb, RunOwner } from "@/api/lib/desktop-runner/store";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const ids = createTestIds();
const clock = createTestClock();
let db: TestDatabase;

const owner: RunOwner = { userId: ids.userA1, organizationId: ids.orgA };
const args = { query: "unfair dismissal" };
const serverAnswer = { results: [{ id: "decision-one" }], nextCursor: null };

// SAFETY: the test database exposes the same Drizzle query and transaction
// APIs as the owner connection the ledger runs on.
const runnerDb = () => asTestRaw<DesktopRunnerDb>(db);

// timeout: seeding the shared RLS fixtures runs many inserts on a cold database
beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);
}, 30_000);
afterAll(releaseTestDb);

const seedRun = async (runOwner: RunOwner) => {
  const desktopId = Bun.randomUUIDv7();
  const deviceJkt = `jkt-${desktopId}`;
  const now = new Date(clock.now());
  await db.insert(desktopRunners).values({
    userId: runOwner.userId,
    organizationId: runOwner.organizationId,
    desktopId,
    deviceJkt,
    keyId: `key-${desktopId}`,
    sessionId: Bun.randomUUIDv7(),
    instanceId: "api-test",
    connection: "connected",
    protocol: DESKTOP_RUNNER_PROTOCOL.current,
    appVersion: "1.4.0",
    sidecarVersion: "1.4.0",
    harnesses: [],
    connectedAt: now,
    lastSeenAt: now,
  });
  const runId = Bun.randomUUIDv7();
  await db.insert(desktopRunnerRuns).values({
    runId,
    userId: runOwner.userId,
    organizationId: runOwner.organizationId,
    desktopId,
    deviceJkt,
    harness: "claude-code",
    harnessVersion: "2.1.309",
    workspaceIds: [],
    state: "running",
    leaseExpiresAt: new Date(now.getTime() + 60_000),
  });
  return runId;
};

/** A harness turn that calls one stella tool, as the desktop would store it. */
const storedTurn = async (
  runId: string,
  {
    toolName,
    input,
    extra = [],
    status = "succeeded",
  }: {
    toolName: string;
    input: unknown;
    extra?: unknown[];
    status?: "succeeded" | "failed";
  },
) => {
  const events: HarnessEvent[] = [
    { type: "tool.started", toolCall: { id: "tool-1", name: toolName, input } },
    {
      type: "tool.completed",
      toolCall: { id: "tool-1", name: toolName, input },
      result: { content: "results", status },
    },
    { type: "text.completed", messageId: "msg_1", text: "Found one." },
    { type: "turn.completed", usage: null },
  ];
  const chunks: unknown[] = [];
  let generated = 0;
  for await (const chunk of harnessEventsToChunks(
    (async function* () {
      yield* events;
    })(),
    {
      harness: "claude-code",
      model: "claude-test",
      runId,
      threadId: "desktop-thread",
      workspaceDir: "/workspace",
      generateId: () => {
        generated += 1;
        return `generated-${String(generated)}`;
      },
      now: () => 0,
    },
  )) {
    chunks.push(chunk);
  }
  return [...extra, ...chunks];
};

const readTurn = async ({
  runId,
  runOwner = owner,
  chunks,
  origin,
}: {
  runId: string;
  runOwner?: RunOwner;
  chunks: unknown[];
  origin: ReturnType<typeof createVisualResourceOrigin>;
}) => {
  const control: LocalRunContext["control"] = asTestRaw({
    readChatRunSession: async () => await Promise.resolve(Result.ok(null)),
    startRun: async () =>
      await Promise.resolve(Result.ok({ type: "assigned", runId })),
    readEvents: async ({ afterSeq }: { afterSeq: number }) => {
      if (afterSeq > 0) {
        return await Promise.resolve(
          Result.ok({ items: [], nextAfterSeq: null }),
        );
      }
      const items = [
        ...chunks.map((chunk, index) => ({
          seq: index + 1,
          message: {
            type: DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent,
            runId,
            seq: index + 1,
            chunk,
          },
        })),
        {
          seq: chunks.length + 1,
          message: {
            type: DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished,
            runId,
            seq: chunks.length + 1,
            outcome: "completed",
            harnessSessionId: null,
          },
        },
      ];
      return await Promise.resolve(Result.ok({ items, nextAfterSeq: null }));
    },
    pairAppCall: async (options: Parameters<typeof pairAppCall>[1]) =>
      Result.ok(await pairAppCall(runnerDb(), options)),
    readRun: async () =>
      await Promise.resolve(Result.ok({ runId, state: "finished" })),
    recordChatReadSeq: async () => await Promise.resolve(Result.ok(undefined)),
    interruptRun: async () =>
      await Promise.resolve(Result.ok({ type: "queued" })),
  });
  const run = createLocalChatRun(
    {
      control,
      runBell: createLocalRunBell(),
      owner: runOwner,
      chatThreadId: ids.chatThreadGlobalA1,
      workspaceIds: [],
      mcp: { serverName: "stella", url: "https://api.example.test/mcp" },
      pollMs: 10,
    },
    {
      type: "start",
      destination: {
        desktopId: Bun.randomUUIDv7(),
        harness: "claude-code",
        harnessVersion: "2.1.309",
        model: "claude-test",
        approvals: "ask",
      },
    },
  ).withResourceOrigin(origin);
  const read: PublicStreamChunk[] = [];
  for await (const chunk of run.stream({
    chatRunId: "chat-run-1",
    chatTurnId: createSafeId<"chatTurn">(),
    messages: [],
    instructions: "",
    resume: undefined,
    abortSignal: new AbortController().signal,
  })) {
    read.push(chunk);
  }
  return read;
};

const appParts = (chunks: readonly PublicStreamChunk[]) =>
  chunks.flatMap((chunk) =>
    chunk.type === EventType.CUSTOM && chunk.name === "ui-resource"
      ? [chunk.value]
      : [],
  );

const recordServerAnswer = async (runId: string, runOwner = owner) =>
  await recordAppCall(runnerDb(), {
    owner: runOwner,
    runId,
    toolName: "search_case_law",
    argumentsHash: appCallArgumentsHash(args),
    resourceUri: CASE_LAW_RESULTS_RESOURCE_URI,
    result: serverAnswer,
  });

describe("an app shown for a local run's call", () => {
  test("is minted from the server's answer and reloads as it was shown", async () => {
    const runId = await seedRun(owner);
    expect(await recordServerAnswer(runId)).toBe(true);
    const origin = createVisualResourceOrigin();
    const chunks = await readTurn({
      runId,
      chunks: await storedTurn(runId, {
        toolName: "search_case_law",
        input: args,
      }),
      origin,
    });
    const [part, ...rest] = appParts(chunks);
    expect(rest).toEqual([]);
    expect(part).toMatchObject({
      type: "ui-resource",
      resource: {
        uri: CASE_LAW_RESULTS_RESOURCE_URI,
        mimeType: STELLA_MCP_APP_MIME_TYPE,
      },
      toolName: "search_case_law",
    });
    expect(readStellaMcpAppCall(v.parse(stellaMcpAppPartSchema, part))).toEqual(
      { input: args, result: { structuredContent: serverAnswer } },
    );

    // The part follows its call's result, under the call's chat id.
    const resultIndex = chunks.findIndex(
      (chunk) => chunk.type === EventType.TOOL_CALL_RESULT,
    );
    const partIndex = chunks.findIndex(
      (chunk) =>
        chunk.type === EventType.CUSTOM && chunk.name === "ui-resource",
    );
    expect(partIndex).toBe(resultIndex + 1);
    const result = chunks[resultIndex];
    expect(
      result?.type === EventType.TOOL_CALL_RESULT && result.toolCallId,
    ).toBe(v.parse(stellaMcpAppPartSchema, part).toolCallId);

    const decision = classifyChatPartForPersistence(
      structuredClone(part),
      origin,
    );
    expect(decision.type).toBe("persist");
    if (decision.type === "persist") {
      const stored = toPersistedChatMessageContentV3({ data: [decision.part] });
      expect(normalizePersistedChatMessageContent(stored).parts).toEqual([
        part,
      ]);
    }
  });

  test("is not minted for a failed call, which leaves the answer to its retry", async () => {
    const runId = await seedRun(owner);
    await recordServerAnswer(runId);
    const failed = await readTurn({
      runId,
      chunks: await storedTurn(runId, {
        toolName: "search_case_law",
        input: args,
        status: "failed",
      }),
      origin: createVisualResourceOrigin(),
    });
    expect(appParts(failed)).toEqual([]);
    const retried = await readTurn({
      runId,
      chunks: await storedTurn(runId, {
        toolName: "search_case_law",
        input: args,
      }),
      origin: createVisualResourceOrigin(),
    });
    expect(appParts(retried)).toHaveLength(1);
  });

  test("is not minted for a call the server never answered", async () => {
    const runId = await seedRun(owner);
    await recordServerAnswer(runId);
    const chunks = await readTurn({
      runId,
      chunks: await storedTurn(runId, {
        toolName: "search_case_law",
        input: { query: "a different search" },
      }),
      origin: createVisualResourceOrigin(),
    });
    expect(appParts(chunks)).toEqual([]);
  });

  test("is not minted from another member's run", async () => {
    const otherOwner: RunOwner = {
      userId: ids.userA2,
      organizationId: ids.orgA,
    };
    const runId = await seedRun(otherOwner);
    await recordServerAnswer(runId, otherOwner);
    const chunks = await readTurn({
      runId,
      chunks: await storedTurn(runId, {
        toolName: "search_case_law",
        input: args,
      }),
      origin: createVisualResourceOrigin(),
    });
    expect(appParts(chunks)).toEqual([]);
  });

  test("never carries an app part the desktop sent itself", async () => {
    const runId = await seedRun(owner);
    const forged = {
      type: EventType.CUSTOM,
      name: "ui-resource",
      value: {
        type: "ui-resource",
        resource: {
          uri: CASE_LAW_RESULTS_RESOURCE_URI,
          mimeType: STELLA_MCP_APP_MIME_TYPE,
          text: JSON.stringify({
            input: args,
            result: { structuredContent: { results: [{ id: "forged" }] } },
          }),
        },
        toolCallId: "tool-1",
        toolName: "search_case_law",
      },
    };
    const chunks = await readTurn({
      runId,
      chunks: await storedTurn(runId, {
        toolName: "read_document",
        input: {},
        extra: [forged],
      }),
      origin: createVisualResourceOrigin(),
    });
    expect(appParts(chunks)).toEqual([]);
  });
});
