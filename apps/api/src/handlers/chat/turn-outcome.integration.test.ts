import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq, inArray } from "drizzle-orm";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";
import type { TanStackAIProvider } from "@stll/ai-catalog";
import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { AI_ERROR_KINDS } from "@stll/api-contract";
import { propertyTestTimeout } from "@stll/property-testing";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  agentSkills,
  chatMessages,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { toChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import {
  CHAT_TURN_INTERACTION_TYPES,
  CHAT_TURN_STATUSES,
} from "@/api/handlers/chat/chat-turn-state";
import { generateThreadTitle } from "@/api/handlers/chat/generate-thread-title";
import getSuggestedPrompts from "@/api/handlers/chat/get-suggested-prompts";
import { runSubagent } from "@/api/handlers/chat/subagent-runner";
import { createChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { generateThreadRecapText } from "@/api/handlers/chat/thread-recap";
import {
  ASK_USER_TOOL_NAME,
  CREATE_DOCUMENT_TOOL_NAME,
} from "@/api/handlers/chat/tools/native-chat-tool-names";
import type { ChatMessage } from "@/api/handlers/chat/types";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { runChatThreadCompaction } from "@/api/lib/chat/thread-compaction";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { insertTestSkill } from "@/api/tests/helpers/agent-skill-db";
import {
  APPROVAL_TOOL_NAME,
  approvalToolArguments,
  createApprovalHarness,
} from "@/api/tests/helpers/chat-approval-harness";
import { createChatHarnessProfile } from "@/api/tests/helpers/chat-harness-profile";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import type { OracleViolation } from "@/api/tests/helpers/chat-oracles";
import { createPromptPrefixLedger } from "@/api/tests/helpers/chat-prompt-prefix";
import type { ScriptedTurn } from "@/api/tests/helpers/chat-round-trip";
import { TURN_STATUS_CLAIM } from "@/api/tests/helpers/chat-turn-outcome";
import {
  NO_AUDIT,
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import {
  cassetteForModel,
  planCombinationRun,
  reasoningModelOf,
} from "@/api/tests/helpers/provider-request-matrix";
import {
  cassetteFor,
  loadProviderWireCassettes,
  PROVIDER_WIRE_SCENARIOS,
} from "@/api/tests/helpers/provider-wire-cassette";
import type {
  ProviderWireCassette,
  ProviderWireExchange,
} from "@/api/tests/helpers/provider-wire-cassette";
import { installProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import type { ProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import { replayedHarnessModel } from "@/api/tests/helpers/replayed-harness-model";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  AI_ERROR_KIND_SHAPES,
  chatModelOf,
  enumerateSurfaceCombinations,
  enumerateTurnCombinations,
  expectedSettlement,
  FINISH_REASON_SHAPES,
  INTERACTION_POSITIONS,
  RESPONSE_SHAPE_NAMES,
  shapeAnswerOf,
  silentAnswerOf,
  surfaceCombinationKey,
  surfaceCombinationValues,
  TURN_POSITIONS,
  turnCombinationKey,
  turnCombinationValues,
  WIRE_SCENARIO_SHAPES,
} from "@/api/tests/helpers/turn-outcome-matrix";
import type {
  ExpectedSettlement,
  ResponseShape,
  SurfaceCombination,
  TurnCombination,
  SURFACES,
} from "@/api/tests/helpers/turn-outcome-matrix";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { withQueryLogger } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Every settled chat turn against what it showed the user. A turn runs
// through the real send handler and `streamChat`, answered by a provider's
// real adapter reading a response off the wire (`provider-wire-replay.ts`),
// and the web app's own chat runtime reads it as the page does. The harness
// then holds the turn to the `chat.turn.*` oracles (`chat-turn-outcome.ts`):
// a completed turn added something visible, an empty run fails retryably, a
// failure shows an error live and on reload, one terminal event, and the
// live view equals the reload. Here each turn is also held to the status
// and failure code its answer owes (`expectedSettlement`).
//
// What is guaranteed:
// - Every combination of response shape, turn position and provider that
//   the product and the provider's protocol can produce is enumerated, and
//   every exclusion names its predicate (`turn-outcome-matrix.ts`). Pull
//   requests run the all-pairs cover; every night runs every combination
//   in shards (`nightly-property-test.yml`, `TURN_OUTCOME_COMBINATIONS=all`
//   and `TURN_OUTCOME_SHARD`). With three dimensions, the all-triples cover
//   is every combination.
// - The builders that show model output beside the turn (title, recap,
//   suggested prompts, a subagent's answer) never show a blank for any
//   shape, on every provider.
// - The typed records in `turn-outcome-matrix.ts` give every wire scenario,
//   finish reason, error kind, interaction and turn status a shape or
//   position that covers it, or a stated reason; the checks below assert
//   the records and the runs agree.
//
// What is not: model behaviour beyond the recorded and written answers, and
// a subagent's parent turn (its child is the `subagent` surface).

const cassettes = loadProviderWireCassettes();
const turns = enumerateTurnCombinations(cassettes);
const surfaces = enumerateSurfaceCombinations(cassettes);

const turnPlan = planCombinationRun({
  included: turns.included,
  mode: process.env["TURN_OUTCOME_COMBINATIONS"],
  shard: process.env["TURN_OUTCOME_SHARD"],
  valuesOf: turnCombinationValues,
});
const surfacePlan = planCombinationRun({
  included: surfaces.included,
  mode: process.env["TURN_OUTCOME_COMBINATIONS"],
  shard: process.env["TURN_OUTCOME_SHARD"],
  valuesOf: surfaceCombinationValues,
});

/**
 * A rule some turns do not keep yet: its name and the oracles its breach
 * trips. A turn that breaks one still settles as it must.
 */
type KnownRule = {
  name: string;
  oracles: readonly OracleViolation["oracle"][];
};

/**
 * The rules a combination's turn does not keep yet. Each such combination
 * runs as a known finding under the rules' names: it must still break them,
 * and only them, so a broken setup fails it like any other test, and it
 * fails loudly once the turn keeps the rules and the entry goes. None today.
 */
const knownTurnRulesOf = (_combination: TurnCombination): KnownRule[] => [];

const profile = createChatHarnessProfile("turn-outcome.integration.test.ts");

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
let replay: ProviderWireReplay;
let previousMockAI: typeof env.USE_MOCK_AI;
let previousBedrockEndpoint: string | undefined;
const seededThreadIds: SafeId<"chatThread">[] = [];
const seededSkillIds: SafeId<"agentSkill">[] = [];

beforeAll(
  async () =>
    await profile.measure("fixture", async () => {
      const fixture = await getRlsFixture();
      testDb = withQueryLogger(fixture.testDb, profile.logger);
      ids = fixture.ids;
      scopedDb = asTestRaw<ScopedDb>(
        createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
      );
      safeDb = toSafeDbMock(scopedDb);
      previousMockAI = env.USE_MOCK_AI;
      env.USE_MOCK_AI = false;
      previousBedrockEndpoint = process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
      process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] =
        "https://bedrock-runtime.us-east-1.amazonaws.com.cassette.invalid";
      replay = installProviderWireReplay({ profile });
    }),
);

afterAll(async () => {
  try {
    await profile.measure("close", async () => {
      replay.restore();
      env.USE_MOCK_AI = previousMockAI;
      if (previousBedrockEndpoint === undefined) {
        delete process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
      } else {
        process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] =
          previousBedrockEndpoint;
      }
      if (seededThreadIds.length > 0) {
        await testDb
          .delete(chatThreads)
          .where(inArray(chatThreads.id, seededThreadIds));
      }
      if (seededSkillIds.length > 0) {
        await testDb
          .delete(agentSkills)
          .where(inArray(agentSkills.id, seededSkillIds));
      }
      await releaseRlsFixture();
    });
  } finally {
    profile.report();
  }
});

const newThreadId = (): SafeId<"chatThread"> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  return threadId;
};

/** One turn takes a few seconds; a retried failure waits out the SDK's
 *  backoff. */
const TURN_TIMEOUT_MS = 60_000;

// --- Organizations ---------------------------------------------------------------

/** The provider's other model: the side calls', or the fallback's. */
const otherModelOf = (provider: TanStackAIProvider): string =>
  reasoningModelOf(provider, chatModelOf(cassettes, provider));

/**
 * The organization a turn runs in. With `fallback`, its reasoning model
 * differs from its chat model, so an empty answer runs the fallback there;
 * otherwise the two are one model and no fallback runs. Side calls (the
 * title) go to whichever model the chat turn does not use first.
 */
const orgConfigOf = (
  provider: TanStackAIProvider,
  { fallback }: { fallback: boolean },
): OrgAIConfig => {
  const chat = { provider, modelId: chatModelOf(cassettes, provider) };
  const other = { provider, modelId: otherModelOf(provider) };
  return {
    providers: [{ provider, apiKey: "cassette-replay-no-credentials" }],
    overrideModels: fallback
      ? { chat, fast: chat, pdf: chat, reasoning: other }
      : { chat, fast: other, pdf: other, reasoning: chat },
    decision: null,
  };
};

/** `exchanges` served as `provider`'s answers under `model`. */
const answersFor = (
  provider: TanStackAIProvider,
  exchanges: readonly ProviderWireExchange[],
  model: string,
): ProviderWireCassette =>
  cassetteForModel(
    { ...cassetteFor(cassettes, provider, "text"), exchanges: [...exchanges] },
    model,
  );

// --- Setting up each position ------------------------------------------------

const CALL_UNDER_TEST = "call-under-test";
const ASK_USER_ARGUMENTS = JSON.stringify({
  analysis: "The draft depends on the side the user represents.",
  questions: [{ question: "Which side?", reason: "It decides the draft." }],
});
const ASK_USER_ANSWER = {
  answers: [{ answer: "Buyer", question: "Which side?" }],
};
const DRAFT_ARGUMENTS = JSON.stringify({
  name: "Mutual NDA",
  source: "@title Mutual NDA\n\nThe parties keep each other's information.",
});
const DRAFT_RESULT = {
  destination: "download",
  fileName: "Mutual NDA.docx",
  success: true,
};

/** The call a scripted first turn waits on, by the position answering it. */
const SCRIPTED_CALL = {
  "after-ask-user": {
    arguments: ASK_USER_ARGUMENTS,
    toolName: ASK_USER_TOOL_NAME,
  },
  "after-approval": {
    arguments: approvalToolArguments(CALL_UNDER_TEST),
    toolName: APPROVAL_TOOL_NAME,
  },
  "after-denial": {
    arguments: approvalToolArguments(CALL_UNDER_TEST),
    toolName: APPROVAL_TOOL_NAME,
  },
  "after-client-tool": {
    arguments: DRAFT_ARGUMENTS,
    toolName: CREATE_DOCUMENT_TOOL_NAME,
  },
} as const;

/**
 * The thread as the position leaves it for the turn under test, written by
 * the production send path on a scripted model (the history does not depend
 * on the provider that answers next).
 */
const prepareThread = async (
  combination: TurnCombination,
  threadId: SafeId<"chatThread">,
): Promise<void> => {
  const { position, provider } = combination;
  const script = async (
    run: (harness: ReturnType<typeof createApprovalHarness>) => Promise<void>,
  ) => {
    const harness = createApprovalHarness({
      profile,
      ids,
      safeDb,
      scopedDb,
      testDb,
    });
    try {
      await run(harness);
    } finally {
      await harness.close();
    }
  };
  switch (position) {
    case "fresh":
    case "after-tool-result":
    case "skill-run":
    case "fallback":
    case "subagent-child":
      return;
    case "after-ask-user":
    case "after-approval":
    case "after-denial":
    case "after-client-tool": {
      const call = SCRIPTED_CALL[position];
      await script(async (harness) => {
        const client = await harness.openWebClient(threadId);
        harness.script(threadId, [
          { ...call, toolCallId: CALL_UNDER_TEST, type: "tool-call" },
        ]);
        await client.sendUserMessage(Bun.randomUUIDv7(), "Draft the NDA");
        await harness.expectSoundWebClient({ client, threadId });
        client.dispose();
      });
      return;
    }
    case "after-compaction": {
      await script(async (harness) => {
        const client = await harness.openWebClient(threadId);
        const answer: ScriptedTurn = {
          finishReason: "stop",
          text: "Here is a mutual NDA with a two-year term.",
          type: "text",
        };
        harness.script(threadId, [answer]);
        await client.sendUserMessage(Bun.randomUUIDv7(), "Draft the NDA");
        await harness.expectSoundWebClient({ client, threadId });
        client.dispose();
      });
      replay.takeFindings();
      replay.serve(
        answersFor(
          provider,
          cassetteFor(cassettes, provider, "text").exchanges,
          chatModelOf(cassettes, provider),
        ),
      );
      const outcome = await runChatThreadCompaction({
        abortSignal: AbortSignal.timeout(TURN_TIMEOUT_MS),
        dataWorkspaceIds: [],
        orgAIConfig: orgConfigOf(provider, { fallback: false }),
        managedAIResidency: "eu" as const,
        organizationId: ids.orgA,
        admission: testModelAdmission(ids.orgA),
        preserveTokens: 1,
        safeDb,
        threadId,
        triggerTokens: 1,
      });
      replay.takeFindings();
      expect(
        Result.isOk(outcome) ? outcome.value.type : outcome.error.message,
      ).toBe("advanced");
      return;
    }
    case "resume-after-restart": {
      await script(async (harness) => {
        const client = await harness.openWebClient(threadId);
        harness.script(threadId, [{ type: "stall" }]);
        harness.crashDuringNextRequest(threadId);
        await client.sendUserMessage(Bun.randomUUIDv7(), "Draft the NDA");
        client.dispose();
        await harness.reapOwnerlessTurns();
      });
      return;
    }
    default:
      position satisfies never;
      return panic(`Unhandled position: ${String(position)}`);
  }
};

/** The skill a skill run sends active. */
const activeSkillOf = async () => {
  const skillName = `review-${Bun.randomUUIDv7()}`;
  const skillId = await insertTestSkill(testDb, {
    name: skillName,
    organizationId: ids.orgA,
    slug: skillName,
    userId: ids.userA1,
  });
  seededSkillIds.push(skillId);
  return { skillId, skillName };
};

/** The model call before the one under test, in the same run: a call of a
 *  tool the loop runs at once. */
const plainCallOf = (provider: TanStackAIProvider): ProviderWireExchange[] => {
  const answer = shapeAnswerOf(cassettes, provider, "tool-call-then-empty");
  if ("notApplicable" in answer) {
    return panic(`${provider} streams a tool call`);
  }
  // The first exchange is the call; the rest is the empty answer after it.
  return answer.exchanges.slice(0, 1);
};

type SettledTurn = {
  failureCode: string | null;
  failureRetryable: boolean | null;
  status: (typeof CHAT_TURN_STATUSES)[number];
};

/** A settled turn as its expectation reads it: `any` where none is owed. */
const settlementOf = (
  turn: SettledTurn | undefined,
  expected: ExpectedSettlement,
): unknown => {
  if (turn === undefined) {
    return null;
  }
  if (turn.status !== "failed" || expected.status !== "failed") {
    return { status: turn.status };
  }
  return {
    failureCode: expected.failureCode === "any" ? "any" : turn.failureCode,
    failureRetryable:
      expected.failureRetryable === "any" ? "any" : turn.failureRetryable,
    status: turn.status,
  };
};

type TurnResult = {
  /** Whether the run stored the reasoning it streamed, where it streamed
   *  some. */
  reasoningStored: boolean | "n/a";
  settlement: unknown;
  violations: OracleViolation[];
};

/**
 * Runs the combination's turn: the thread its position leaves, then a page
 * on the provider's adapter answering the position's action, whose model
 * call reads the shape off the wire.
 */
const runTurn = async (combination: TurnCombination): Promise<TurnResult> =>
  await profile.measure("action", async () => {
    const { position, provider, shape } = combination;
    const answer = shapeAnswerOf(cassettes, provider, shape);
    if ("notApplicable" in answer) {
      return panic(`Excluded: ${answer.notApplicable}`);
    }
    const expected = expectedSettlement(answer.verdict, position);
    const threadId = newThreadId();
    replay.forgetSignedCalls();
    await profile.measure(
      "prepare",
      async () => await prepareThread(combination, threadId),
    );

    const fallback = position === "fallback";
    const seam = replayedHarnessModel({
      prompts: createPromptPrefixLedger(),
      provider,
      replay,
    });
    const harness = createApprovalHarness({
      profile,
      ids,
      model: seam,
      organizationAIConfig: orgConfigOf(provider, { fallback }),
      safeDb,
      scopedDb,
      testDb,
    });
    const context =
      position === "skill-run"
        ? await (async () => {
            const skill = await activeSkillOf();
            return { getActiveSkill: () => skill };
          })()
        : undefined;
    const client = await harness.openWebClient(threadId, { context });
    try {
      const chatModel = chatModelOf(cassettes, provider);
      replay.takeFindings();
      if (fallback) {
        // The chat model says nothing; the fallback answers with the shape.
        replay.answerSideCalls(
          silentAnswerOf(
            provider,
            answersFor(
              provider,
              cassetteFor(cassettes, provider, "text").exchanges,
              chatModel,
            ),
          ).exchanges[0],
        );
        replay.serve(
          answersFor(provider, answer.exchanges, otherModelOf(provider)),
        );
      } else {
        replay.answerSideCalls(
          answersFor(
            provider,
            cassetteFor(cassettes, provider, "text").exchanges,
            otherModelOf(provider),
          ).exchanges[0],
        );
        replay.serve(
          answersFor(
            provider,
            position === "after-tool-result"
              ? [...plainCallOf(provider), ...answer.exchanges]
              : answer.exchanges,
            chatModel,
          ),
        );
      }
      switch (position) {
        case "fresh":
        case "after-tool-result":
        case "after-compaction":
        case "skill-run":
        case "fallback":
        case "subagent-child":
          await client.sendUserMessage(Bun.randomUUIDv7(), "Summarize the NDA");
          break;
        case "after-ask-user":
          await client.answer(CALL_UNDER_TEST, ASK_USER_ANSWER);
          break;
        case "after-approval":
        case "after-denial":
          await client.approve(CALL_UNDER_TEST, position === "after-approval");
          break;
        case "after-client-tool":
          await client.runClientTool(
            CALL_UNDER_TEST,
            CREATE_DOCUMENT_TOOL_NAME,
            DRAFT_RESULT,
          );
          break;
        case "resume-after-restart":
          await client.resend();
          break;
        default:
          position satisfies never;
      }
      const violations = await harness.checkWebClient({
        client,
        expected: { runFailure: expected.status === "failed" },
        threadId,
      });
      const [turn] = await testDb
        .select({
          failureCode: chatTurns.failureCode,
          failureRetryable: chatTurns.failureRetryable,
          status: chatTurns.status,
        })
        .from(chatTurns)
        .where(eq(chatTurns.threadId, threadId))
        .orderBy(desc(chatTurns.createdAt), desc(chatTurns.id))
        .limit(1);
      const stored = await harness.readThreadMessages(threadId);
      return {
        reasoningStored: answer.reasoning
          ? stored.some(({ parts }) =>
              parts.some(({ type }) => type === "thinking"),
            )
          : "n/a",
        settlement: settlementOf(turn, expected),
        violations,
      };
    } finally {
      client.dispose();
      await harness.close();
      replay.answerSideCalls(undefined);
      replay.takeFindings();
    }
  });

// --- Surfaces -------------------------------------------------------------------

const TRANSCRIPT = [
  "Draft a mutual NDA for Acme and Globex.",
  "Here is a mutual NDA with a two-year term.",
  "Shorten the term to one year.",
  "Done: the term is now one year.",
] as const;

const chatMessagesOf = (texts: readonly string[]): ChatMessage[] =>
  texts.map((text, index) => ({
    id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
    parts: [{ content: text, type: "text" }],
    role: index % 2 === 0 ? "user" : "assistant",
  }));

const INITIAL_TITLE = "New chat";

/** A thread of `TRANSCRIPT`, as the send path stores one. */
const seedThread = async (): Promise<SafeId<"chatThread">> => {
  const threadId = newThreadId();
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: INITIAL_TITLE,
    userId: ids.userA1,
  });
  await testDb.insert(chatMessages).values(
    TRANSCRIPT.map((text, index) => ({
      content: toChatMessageContent({
        data: [{ content: text, type: "text" }],
        version: 2,
      }),
      createdAt: new Date(Date.parse("2026-08-03T12:00:00.000Z") + index),
      id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      threadId,
      userId: ids.userA1,
    })),
  );
  return threadId;
};

const safeDbOf = (): SafeDb =>
  asTestRaw<SafeDb>(
    createSafeDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );

/** Every string of `value` found under a `prompts` key. */
const promptsIn = (value: unknown): unknown[] => {
  if (isUnknownArray(value)) {
    return value.flatMap(promptsIn);
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    key === "prompts" && isUnknownArray(child) ? child : promptsIn(child),
  );
};

const isBlank = (text: unknown): boolean =>
  typeof text !== "string" || text.trim() === "";

/**
 * What each surface shows once its builder ran on the organization `run`
 * configures: every text the page would render from it.
 */
const SURFACE_SHOWS = {
  "thread-title": async (orgAIConfig) => {
    const threadId = await seedThread();
    const [first, second] = chatMessagesOf(TRANSCRIPT);
    await generateThreadTitle({
      indexThread: async () => await Promise.resolve(),
      initialTitle: INITIAL_TITLE,
      messages: [
        first ?? panic("The transcript opens with a user message"),
        second ?? panic("The transcript answers it"),
      ],
      organizationId: ids.orgA,
      orgAIConfig,
      managedAIResidency: "eu" as const,
      promptCachingEnabled: false,
      recordAuditEvent: async () => await Promise.resolve(),
      safeDb: safeDbOf(),
      threadId,
      threadWorkspaceId: null,
      userId: ids.userA1,
    });
    const thread = await testDb.query.chatThreads.findFirst({
      columns: { title: true },
      where: { id: { eq: threadId } },
    });
    return [thread?.title ?? null];
  },
  "thread-recap": async (orgAIConfig) => {
    const recap = await generateThreadRecapText({
      messages: chatMessagesOf(TRANSCRIPT),
      organizationId: ids.orgA,
      admission: testModelAdmission(ids.orgA),
      orgAIConfig,
      managedAIResidency: "eu" as const,
      promptCachingEnabled: false,
      threadId: await seedThread(),
      workspaceId: null,
    });
    return recap === null ? [] : [recap];
  },
  "follow-up-suggestions": async (orgAIConfig) => {
    const answer: unknown = await getSuggestedPrompts.handler(
      asTestRaw<Parameters<typeof getSuggestedPrompts.handler>[0]>(
        createTestHandlerContext({
          audit: NO_AUDIT,
          scopedDb: NO_DB,
          memberRole: sessionMemberRole("owner"),
          orgAIConfig,
          orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
          managedAIResidency: "eu" as const,
          params: { threadId: await seedThread() },
          promptCachingEnabled: false,
          query: {},
          request: new Request("http://localhost/v1/chat"),
          safeDb: safeDbOf(),
          session: { activeOrganizationId: ids.orgA },
          user: { id: ids.userA1 },
        }),
      ),
    );
    const body: unknown =
      answer instanceof Response ? await answer.json() : answer;
    return promptsIn(body);
  },
  subagent: async (orgAIConfig) => {
    const result = await runSubagent({
      abortSignal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      delegationDepth: 1,
      maxSteps: 4,
      messages: chatMessagesOf(["Find the termination clause."]),
      metering: {
        feature: "subagent",
        safeDb: safeDbOf(),
        serviceTier: "standard",
        sessionId: Bun.randomUUIDv7(),
        traceId: Bun.randomUUIDv7(),
        userId: ids.userA1,
        workspaceId: null,
      },
      organizationId: ids.orgA,
      admission: testModelAdmission(ids.orgA),
      orgAIConfig,
      managedAIResidency: "eu" as const,
      role: "fast",
      systemSafe: "Answer briefly.",
      systemUntrusted: "Return the clause text.",
      tenantWorkspaceIds: [],
      thirdPartyBoundary: createChatThirdPartyBoundary({
        anonymizationScopeId: Bun.randomUUIDv7(),
        organizationId: ids.orgA,
        scopedDb,
        sendMode: CHAT_SEND_MODE.rawOverride,
        threadRestorations: [],
      }),
      tools: {},
    });
    // A failed subagent reaches its parent as a tool error, never a blank.
    return result.outcome === "completed" ? [result.text] : [result.message];
  },
} as const satisfies Record<
  keyof typeof SURFACES,
  (orgAIConfig: OrgAIConfig) => Promise<unknown[]>
>;

/** `chat.surface.empty-shows-nothing` for one surface combination, and
 *  whether its builder reached the provider at all. */
const runSurface = async (
  combination: SurfaceCombination,
): Promise<{ reachedProvider: boolean; violations: OracleViolation[] }> =>
  await profile.measure("action", async () => {
    const { provider, shape, surface } = combination;
    const answer = shapeAnswerOf(cassettes, provider, shape);
    if ("notApplicable" in answer) {
      return panic(`Excluded: ${answer.notApplicable}`);
    }
    const model = chatModelOf(cassettes, provider);
    replay.takeFindings();
    replay.forgetSignedCalls();
    replay.serve(answersFor(provider, answer.exchanges, model));
    try {
      const shown = await SURFACE_SHOWS[surface](
        orgConfigOf(provider, { fallback: false }),
      );
      return {
        reachedProvider: replay.requests().length > 0,
        violations: violationsOf(
          CHAT_ORACLE.surfaceEmptyShowsNothing,
          shown.filter(isBlank).map((blank) => ({ blank, surface })),
        ),
      };
    } finally {
      replay.takeFindings();
    }
  });

// --- Tests --------------------------------------------------------------------

/** What a combination's turn owes: its settlement, and no violation. */
const expectedResultOf = (combination: TurnCombination): TurnResult => {
  const answer = shapeAnswerOf(
    cassettes,
    combination.provider,
    combination.shape,
  );
  return "notApplicable" in answer
    ? panic("An included combination has an answer")
    : {
        reasoningStored: answer.reasoning ? true : "n/a",
        settlement: expectedSettlement(answer.verdict, combination.position),
        violations: [],
      };
};

describe(`settled chat turns: ${String(turns.included.length)} combinations the product can produce (${String(turns.excluded.length)} excluded by a named predicate); ${turnPlan.mode}: ${String(turnPlan.runs.length)} run`, () => {
  test("every excluded combination names the predicate that excludes it", () => {
    expect(
      [...turns.excluded, ...surfaces.excluded].filter(
        ({ predicate }) => predicate.trim() === "",
      ),
    ).toEqual([]);
  });

  test("every wire scenario, finish reason and error kind names a shape, and every shape is named by one", () => {
    const named = new Set<ResponseShape>(
      [WIRE_SCENARIO_SHAPES, FINISH_REASON_SHAPES, AI_ERROR_KIND_SHAPES]
        .flatMap((record) => Object.values(record))
        .flatMap((entry) => (Array.isArray(entry) ? entry : [])),
    );
    expect(
      RESPONSE_SHAPE_NAMES.filter(
        (shape) => shape !== "structured-output-empty" && !named.has(shape),
      ),
    ).toEqual([]);
    // Both directions: the records are keyed by the source unions.
    expect(Object.keys(WIRE_SCENARIO_SHAPES).toSorted()).toEqual(
      Object.keys(PROVIDER_WIRE_SCENARIOS).toSorted(),
    );
    expect(Object.keys(AI_ERROR_KIND_SHAPES).toSorted()).toEqual(
      [...AI_ERROR_KINDS].toSorted(),
    );
    expect(Object.keys(INTERACTION_POSITIONS).toSorted()).toEqual(
      [...CHAT_TURN_INTERACTION_TYPES].toSorted(),
    );
    expect(Object.keys(TURN_STATUS_CLAIM).toSorted()).toEqual(
      [...CHAT_TURN_STATUSES].toSorted(),
    );
  });

  test("every shape, position and provider runs in some included combination", () => {
    const seen = (pick: (combination: TurnCombination) => string) =>
      new Set(turns.included.map(pick));
    expect({
      positions: Object.keys(TURN_POSITIONS).filter(
        (position) =>
          position !== "subagent-child" &&
          !seen(({ position: value }) => value).has(position),
      ),
      providers: TANSTACK_AI_PROVIDERS.filter(
        (provider) => !seen(({ provider: value }) => value).has(provider),
      ),
      shapes: RESPONSE_SHAPE_NAMES.filter(
        (shape) =>
          shape !== "structured-output-empty" &&
          !seen(({ shape: value }) => value).has(shape),
      ),
    }).toEqual({ positions: [], providers: [], shapes: [] });
  });

  for (const combination of turnPlan.runs) {
    const known = knownTurnRulesOf(combination);
    const check = async () => {
      const expected = expectedResultOf(combination);
      const result = await runTurn(combination);
      // A known finding still breaks its rules, and nothing else.
      const allowed = new Set(known.flatMap(({ oracles }) => oracles));
      const knownView = (view: TurnResult, stillBroken: boolean) => ({
        reasoningStored: view.reasoningStored,
        settlement: view.settlement,
        stillBroken,
        unexpected: view.violations.filter(
          ({ oracle }) => !allowed.has(oracle),
        ),
      });
      expect(
        known.length === 0
          ? result
          : knownView(result, !Bun.deepEquals(result, expected)),
      ).toEqual(known.length === 0 ? expected : knownView(expected, true));
    };
    const name = turnCombinationKey(combination);
    test(
      known.length === 0
        ? `${name}: settles as it showed`
        : `${name}: known finding: ${known.map(({ name: rule }) => rule).join("; ")}`,
      check,
      propertyTestTimeout(TURN_TIMEOUT_MS),
    );
  }
});

describe(`chat surfaces: ${String(surfaces.included.length)} combinations (${String(surfaces.excluded.length)} excluded by a named predicate); ${surfacePlan.mode}: ${String(surfacePlan.runs.length)} run`, () => {
  for (const combination of surfacePlan.runs) {
    test(
      `${surfaceCombinationKey(combination)}: shows nothing rather than a blank`,
      async () => {
        expect(await runSurface(combination)).toEqual({
          reachedProvider: true,
          violations: [],
        });
      },
      propertyTestTimeout(TURN_TIMEOUT_MS),
    );
  }
});
