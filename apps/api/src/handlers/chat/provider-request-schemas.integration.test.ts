import { toolDefinition } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import fc from "fast-check";
import * as v from "valibot";

import {
  BYOK_MODEL_OPTIONS,
  getModelImageInputCapability,
  TANSTACK_AI_PROVIDERS,
} from "@stll/ai-catalog";
import type { TanStackAIProvider } from "@stll/ai-catalog";
import {
  BUILT_IN_CHAT_TOOL_POLICY_KINDS,
  MCP_CHAT_TOOL_POLICY_KINDS,
} from "@stll/api-contract";
import type { ChatToolPolicyKind } from "@stll/api-contract";
import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  chatMessages,
  chatThreadCompactions,
  chatThreads,
  userFiles,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import {
  isProviderVisibleChatPart,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import type { createStellaMcpToolSource } from "@/api/handlers/chat/tools/external-mcp-tools";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { encodeChatModelSelection } from "@/api/lib/chat-model-selection";
import { BEDROCK_IMAGE_MAX_BYTES } from "@/api/lib/chat/provider-image-input";
import type { StreamChatChunksOptions } from "@/api/lib/chat/tanstack-chat-runtime";
import { runChatThreadCompaction } from "@/api/lib/chat/thread-compaction";
import { toDataUrl } from "@/api/lib/data-url";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import {
  APPROVAL_TOOL_NAME,
  createApprovalHarness,
  pendingApprovalCallOf,
} from "@/api/tests/helpers/chat-approval-harness";
import { composerAttachmentPart } from "@/api/tests/helpers/chat-attachment-parts";
import { createChatHarnessProfile } from "@/api/tests/helpers/chat-harness-profile";
import { CHAT_ORACLE } from "@/api/tests/helpers/chat-oracles";
import type { OracleViolation } from "@/api/tests/helpers/chat-oracles";
import { createPromptPrefixLedger } from "@/api/tests/helpers/chat-prompt-prefix";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import {
  ATTACHMENTS,
  cassetteForModel,
  chatCombinationValues,
  combinationKey,
  enumerateChatCombinations,
  findForeignRequestArtifacts,
  modelOf,
  planCombinationRun,
  reasoningModelOf,
  toolCallAnswerFor,
} from "@/api/tests/helpers/provider-request-matrix";
import type {
  AttachmentKind,
  CachingSetting,
  ChatCombination,
  ModelEndpoint,
  ToolSurface,
} from "@/api/tests/helpers/provider-request-matrix";
import {
  findRequestPathDrift,
  OPAQUE_REQUEST_PATHS,
  readRequestPathInventory,
  requestPathsOf,
  updatingRequestPaths,
  writeRequestPaths,
} from "@/api/tests/helpers/provider-request-paths";
import {
  ACCEPTED_BEYOND_SCHEMA,
  findProviderRuleViolations,
  findRequestSchemaViolations,
  requestSchemaIdOf,
} from "@/api/tests/helpers/provider-request-schema";
import type { ProviderRequestSchemaId } from "@/api/tests/helpers/provider-request-schema";
import {
  cassetteFor,
  loadProviderWireCassettes,
} from "@/api/tests/helpers/provider-wire-cassette";
import type { ProviderWireCassette } from "@/api/tests/helpers/provider-wire-cassette";
import {
  wireOrgAIConfig,
  wireSideModel,
} from "@/api/tests/helpers/provider-wire-contract";
import { installProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import type {
  ProviderWireReplay,
  ReplayedRequest,
} from "@/api/tests/helpers/provider-wire-replay";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import {
  replayedHarnessModel,
  WIRE_PROMPT_SECTIONS,
} from "@/api/tests/helpers/replayed-harness-model";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { silentAnswerOf } from "@/api/tests/helpers/turn-outcome-matrix";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { withQueryLogger } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Every chat request the send path sends a provider, held to what the
// provider accepts. A conversation goes through the real send handler and
// `streamChat`, which build the request (history, tools, model options, the
// run's tool call ids) and hand it to the organization's real adapter; the
// adapter's SDK sends it through `fetch`, where the provider wire replay
// captures the body and answers from a recorded response. No request leaves
// the process. The requests the chat surface's other builders send (titles,
// suggestions, recaps, compaction, subagents, skills) are held to the same
// rules in `provider-request-roles.integration.test.ts`.
//
// What is guaranteed:
// - Every combination of the chat turn's discrete dimensions that the
//   production predicates allow is enumerated, and each exclusion names its
//   predicate (`provider-request-matrix.ts`): the provider and model that
//   wrote the history, whether that history holds their reasoning, a stored
//   structured output, a compaction checkpoint, the provider and model that
//   continue it (a thread can switch models between messages), the
//   organization's caching setting, the turn's attachment, reasoning effort
//   and tool surface, how its model was chosen, whether the chat model or its
//   fallback answers, whether it is anonymized, and whether it runs as a chat
//   turn or an agent run (whose request the sandbox's harness builds, so it
//   is excluded by that predicate). Pull requests run an all-pairs cover of
//   them; every night runs the all-triples cover, and a rotation of rounds
//   runs every combination (`nightly-property-test.yml`).
// - Every request those conversations send (the chat turns, the thread
//   compactor's summary and the side calls) holds to the request schema the
//   provider publishes (`scripts/provider-request-schemas.ts`) and to the
//   provider's documented rules the schema leaves out, and, after a switch,
//   carries no reasoning or cache setting only another provider can read.
//   The harness's own checks run on every step as well, among them
//   `chat.provider.transcript-settled`: every tool call is answered once,
//   right after it, with no orphan result.
// - The typed coverage records below give every provider, request option,
//   message part kind and tool kind one of two states, each checked at run
//   time; the paths the all-pairs requests carry are a committed inventory.
// - Free-form user text is sampled with fast-check (a fixed seed on pull
//   requests, fresh seeds nightly), not exhausted.
//
// What is not: model behaviour (every answer is a recorded or written one,
// reused for the other model of a provider), and what a provider refuses
// that its published schema and documentation do not state.

const cassettes = loadProviderWireCassettes();

// --- Coverage ---------------------------------------------------------------
//
// How the conversations below reach every member of the unions that decide
// what a chat request can hold. A new provider, request option, message part
// kind or tool kind fails typecheck here until it is stated how the check
// covers it, and there are two states only: covered (a runtime check below
// asserts the conversations reach it) or never sent (with the production
// table that says so, which a check below reads).

type Coverage = { covered: string } | { neverSent: string };

/** Each provider's chat endpoint, by the vendored schema its requests are
 *  held to. */
const PROVIDER_CHAT_SCHEMA = {
  anthropic: "anthropic.messages",
  bedrock: "bedrock.converse-stream",
  google: "google.generate-content",
  mistral: "mistral.chat-completions",
  openai: "openai.responses",
  openrouter: "openrouter.chat-completions",
} as const satisfies Record<TanStackAIProvider, ProviderRequestSchemaId>;

const NOT_SET_BY_CHAT = "The chat send path does not set it.";

/** Every option `streamChat` can hand the engine. */
const REQUEST_OPTION_COVERAGE = {
  abortController: { neverSent: "Cancels the run; never serialized." },
  adapter: { covered: "The organization's adapter, from the model factory." },
  agentLoopStrategy: { neverSent: "Bounds the engine's loop." },
  context: { neverSent: NOT_SET_BY_CHAT },
  conversationId: { neverSent: NOT_SET_BY_CHAT },
  debug: { neverSent: NOT_SET_BY_CHAT },
  interrupts: { neverSent: NOT_SET_BY_CHAT },
  lazyToolsConfig: { neverSent: NOT_SET_BY_CHAT },
  mcp: { covered: "The extended tool surface's lazily listed external tool." },
  messages: { covered: "Every turn, the continuation and the later turn." },
  metadata: { neverSent: NOT_SET_BY_CHAT },
  middleware: {
    covered: "The runtime middleware of every attempt (compaction, recovery).",
  },
  modelOptions: {
    covered: "The chat role's generation options, with every effort.",
  },
  parentRunId: { covered: "The continuation after the approval." },
  resume: { covered: "The continuation after the approval." },
  runId: { neverSent: "The engine's own run identity." },
  state: { neverSent: NOT_SET_BY_CHAT },
  subagentRunId: { neverSent: NOT_SET_BY_CHAT },
  subagents: { neverSent: NOT_SET_BY_CHAT },
  systemPrompts: { covered: "The chat system prompt on every request." },
  threadId: { neverSent: "The engine's own thread identity." },
  tools: { covered: "Every tool kind the tool tables give (below)." },
} as const satisfies Record<keyof StreamChatChunksOptions, Coverage>;

const UI_ONLY = "Its part policy keeps it off the provider (`ui-only`).";

/** Every kind of stored message part. */
const PART_KIND_COVERAGE = {
  audio: { neverSent: UI_ONLY },
  document: { covered: "A PDF, text or office attachment." },
  image: { covered: "An image attachment." },
  subagent: { neverSent: UI_ONLY },
  "structured-output": { covered: "A stored completed structured output." },
  text: { covered: "Every user and assistant message." },
  thinking: { covered: "Every provider's reasoning, continued elsewhere." },
  "tool-call": { covered: "The approved call, in the continuation and after." },
  "tool-result": {
    covered: "The approved call's result, in the continuation and after.",
  },
  "ui-resource": { neverSent: UI_ONLY },
  video: { neverSent: UI_ONLY },
} as const satisfies Record<ChatPart["type"], Coverage>;

/**
 * Every kind of chat tool, by its policy. A kind is covered when the
 * conversations' requests declare a tool of it; one no tool table gives any
 * tool is never sent.
 */
const TOOL_KIND_COVERAGE = {
  external: { covered: `${APPROVAL_TOOL_NAME}, web search and URL fetching.` },
  internal: { covered: "Stella's built-in read tools." },
  mutation: { covered: "Stella's built-in write tools." },
  public_official: { covered: "The official legal source tools." },
  public_unofficial: {
    neverSent:
      "No built-in or generated tool has this policy (`BUILT_IN_CHAT_TOOL_POLICY_KINDS`, `MCP_CHAT_TOOL_POLICY_KINDS`).",
  },
  scope_expansion: { covered: "Past-chat search, with matters in context." },
} as const satisfies Record<ChatToolPolicyKind, Coverage>;

/** The policy kind of a tool a request declares, when the tables know it. */
const declaredToolKindOf = (name: string): ChatToolPolicyKind | undefined =>
  name === APPROVAL_TOOL_NAME || name === LAZY_EXTERNAL_TOOL_NAME
    ? "external"
    : [
        ...Object.entries(BUILT_IN_CHAT_TOOL_POLICY_KINDS),
        ...Object.entries(MCP_CHAT_TOOL_POLICY_KINDS),
      ].find(([known]) => known === name)?.[1];

// --- The combinations ---------------------------------------------------------

const combinations = enumerateChatCombinations(cassettes);

/**
 * Which combinations run: the all-pairs cover by default (pull requests),
 * the all-triples cover with `PROVIDER_REQUEST_COMBINATIONS=three-wise`, or
 * every combination with `all` (both nightly), either split by
 * `PROVIDER_REQUEST_SHARD=<index>/<count>`.
 */
const runPlan = planCombinationRun({
  included: combinations.included,
  mode: process.env["PROVIDER_REQUEST_COMBINATIONS"],
  shard: process.env["PROVIDER_REQUEST_SHARD"],
  valuesOf: chatCombinationValues,
});

/** Each provider's own model continuing its own plain history with a plain
 *  turn: the conversation the per-provider checks read, run in every mode. */
const baselineOf = (provider: TanStackAIProvider): ChatCombination => ({
  attachment: "none",
  attempt: "primary",
  caching: "off",
  compaction: "none",
  effort: "default",
  history: "plain",
  origin: { provider, slot: "recorded" },
  runMode: "chat",
  selection: "organization-default",
  sendMode: "rawOverride",
  stored: "none",
  target: { provider, slot: "recorded" },
  tools: "default",
});

const selectedCombinations: readonly ChatCombination[] = (() => {
  const keys = new Set(runPlan.runs.map(combinationKey));
  return [
    ...runPlan.runs,
    ...TANSTACK_AI_PROVIDERS.map(baselineOf).filter(
      (baseline) => !keys.has(combinationKey(baseline)),
    ),
  ];
})();

/**
 * What a combination's turn breaks today, by the rule it breaks. Each such
 * combination runs as a test marked failing under the finding's name, so it
 * fails loudly once the turn stops breaking the rule. None today: a new
 * finding is a condition on the combination that returns the rule it breaks.
 */
const knownFindingOf = (_combination: ChatCombination): string | undefined =>
  undefined;

// --- Conversations ------------------------------------------------------------

/** The organization's external tool the extended surface lists lazily. */
const LAZY_EXTERNAL_TOOL_NAME = "mcp__external__archive";

const lazyExternalTools = (): Parameters<
  typeof createStellaMcpToolSource
>[0]["sourceTools"] => ({
  [LAZY_EXTERNAL_TOOL_NAME]: {
    ...toolDefinition({
      name: LAZY_EXTERNAL_TOOL_NAME,
      description: "Archive a draft by name.",
      inputSchema: toTanStackToolSchema(v.object({ name: v.string() })),
    }).server(async ({ name }) => await Promise.resolve({ archived: name })),
    lazy: true,
  },
});

/** A web search provider and URL fetcher that are never called: the turn
 *  only has to declare their tools. */
const webSources = {
  urlFetcher: {
    name: "jina",
    fetch: async () => await Promise.reject(new TypeError("Not called")),
  },
  webSearchProvider: {
    name: "tavily",
    search: async () => await Promise.reject(new TypeError("Not called")),
  },
} as const;

const profile = createChatHarnessProfile(
  "provider-request-schemas.integration.test.ts",
);

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
let replay: ProviderWireReplay;
let fakeS3: FakeS3;
let previousMockAI: typeof env.USE_MOCK_AI;
let previousBedrockEndpoint: string | undefined;
const seededThreadIds: SafeId<"chatThread">[] = [];

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
      fakeS3 = startFakeS3();
      replay = installProviderWireReplay({
        passThroughOrigins: [fakeS3.endpoint],
        profile,
      });
    }),
);

afterAll(async () => {
  try {
    await profile.measure("close", async () => {
      replay.restore();
      fakeS3.stop();
      env.USE_MOCK_AI = previousMockAI;
      if (previousBedrockEndpoint === undefined) {
        delete process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
      } else {
        process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] =
          previousBedrockEndpoint;
      }
      if (seededThreadIds.length > 0) {
        // Uploaded attachments belong to their thread.
        await testDb
          .delete(userFiles)
          .where(inArray(userFiles.threadId, seededThreadIds));
        await testDb
          .delete(chatThreads)
          .where(inArray(chatThreads.id, seededThreadIds));
      }
      await releaseRlsFixture();
    });
  } finally {
    profile.report();
  }
});

/** The organization whose chat model is `endpoint`'s, with the provider's
 *  other model answering side calls (the thread title). */
const orgConfigOf = (
  endpoint: ModelEndpoint,
  model = modelOf(cassettes, endpoint),
) =>
  wireOrgAIConfig({
    apiKey: "cassette-replay-no-credentials",
    chatModel: model,
    provider: endpoint.provider,
    sideModel: wireSideModel(endpoint.provider, model),
  });

/**
 * The thread `threadId` opened in a page of an organization whose chat model
 * is `endpoint`'s, as a user who picks that model sees it.
 */
const openSession = async ({
  caching,
  endpoint,
  modelId,
  threadId,
  tools,
}: {
  caching: CachingSetting;
  endpoint: ModelEndpoint;
  modelId?: string;
  threadId: SafeId<"chatThread">;
  tools: ToolSurface;
}) => {
  const { provider } = endpoint;
  const model = modelId ?? modelOf(cassettes, endpoint);
  const seam = replayedHarnessModel({
    prompts: createPromptPrefixLedger(),
    provider,
    replay,
  });
  const harness = createApprovalHarness({
    profile,
    ids,
    model: seam,
    organizationAIConfig: orgConfigOf(endpoint, model),
    promptCachingEnabled: caching === "on",
    safeDb,
    scopedDb,
    sources:
      tools === "extended"
        ? {
            contextMatterIds: [ids.wsA1],
            lazyExternalTools: lazyExternalTools(),
            web: webSources,
          }
        : {},
    testDb,
  });
  const client = await harness.openWebClient(threadId);
  const answer = cassetteForModel(
    cassetteFor(cassettes, provider, "text"),
    model,
  );
  replay.answerSideCalls(answer.exchanges[0]);
  return {
    answer,
    client,
    close: async () => {
      client.dispose();
      await harness.close();
      replay.answerSideCalls(undefined);
    },
    harness,
    model,
    seam,
  };
};

/** The requests `run` sends through the replay, answered from `cassette`. */
const requestsOf = async (
  cassette: ProviderWireCassette,
  run: () => Promise<void>,
): Promise<ReplayedRequest[]> => {
  replay.takeFindings();
  replay.serve(cassette);
  await run();
  const sent = [...replay.requests()];
  replay.takeFindings();
  return sent;
};

type Conversation = {
  /** The part kinds the stored thread holds once it is done. */
  partKinds: ReadonlySet<string>;
  /** Every request of the conversation. */
  sent: readonly ReplayedRequest[];
  /** Every request of the turn on the target endpoint. */
  targetRequests: readonly ReplayedRequest[];
  /** Whether the thread holds a compaction checkpoint. */
  compacted: boolean;
};

/** A completed structured output, as a page sends one back. */
const STORED_STRUCTURED_OUTPUT = {
  type: "structured-output",
  status: "complete",
  raw: '{"verdict":"archived"}',
  data: { verdict: "archived" },
} as const satisfies ChatPart;

/**
 * History on `origin`: a first turn with the tools declared, answered with a
 * tool call (after reasoning, for `history: "reasoning"`); the continuation
 * once the page approves it, carrying the call and its result. The stored
 * thread then gains what the combination adds (a stored structured output, a
 * compaction checkpoint the scheduler's compactor writes), the user picks the
 * target's model and effort, and a later turn on `target`, with the
 * combination's attachment and tool surface, rebuilds its request from the
 * stored thread.
 */
const converse = async (combination: ChatCombination): Promise<Conversation> =>
  await profile.measure("action", async () => {
    const {
      attempt,
      attachment,
      caching,
      compaction,
      effort,
      history,
      origin,
      selection,
      sendMode,
      stored,
      target,
      tools,
    } = combination;
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    replay.forgetSignedCalls();
    const prepared = await profile.measure("prepare", async () => {
      const first = await openSession({
        caching,
        endpoint: origin,
        threadId,
        tools: "default",
      });
      let originRequests: readonly ReplayedRequest[];
      try {
        replay.serve(
          cassetteForModel(
            toolCallAnswerFor({
              cassette: cassetteFor(cassettes, origin.provider, "tool-call"),
              history,
              provider: origin.provider,
            }),
            first.model,
          ),
        );
        await first.client.sendUserMessage(
          Bun.randomUUIDv7(),
          "Delete the draft",
        );
        await first.harness.expectSoundWebClient({
          client: first.client,
          threadId,
        });
        const call = pendingApprovalCallOf(
          (await first.harness.lastAssistant(threadId)).parts,
        );
        replay.enqueue(first.answer);
        await first.client.approve(call.id, true);
        await first.harness.expectSoundWebClient({
          client: first.client,
          threadId,
        });
        originRequests = [...first.seam.sentRequests()];
      } finally {
        await first.close();
      }

      if (stored === "structured-output") {
        await testDb.insert(chatMessages).values({
          content: toPersistedChatMessageContentV3({
            data: [STORED_STRUCTURED_OUTPUT],
          }),
          id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
          role: "assistant",
          threadId,
          userId: ids.userA1,
          workspaceId: null,
        });
      }

      let compactionRequests: ReplayedRequest[] = [];
      if (compaction === "compacted") {
        const originModel = modelOf(cassettes, origin);
        compactionRequests = await requestsOf(
          cassetteForModel(
            cassetteFor(cassettes, origin.provider, "text"),
            originModel,
          ),
          async () => {
            const outcome = await runChatThreadCompaction({
              abortSignal: AbortSignal.timeout(CONVERSATION_TIMEOUT_MS),
              dataWorkspaceIds: [],
              orgAIConfig: orgConfigOf(origin),
              managedAIResidency: "eu",
              organizationId: ids.orgA,
              admission: testModelAdmission(ids.orgA),
              preserveTokens: 1,
              safeDb,
              threadId,
              triggerTokens: 1,
            });
            expect(
              Result.isOk(outcome) ? outcome.value.type : outcome.error.message,
            ).toBe("advanced");
          },
        );
      }

      const targetModel = modelOf(cassettes, target);
      await testDb
        .update(chatThreads)
        .set({
          // What the model picker writes (`update-thread-model.ts`).
          chatModel:
            selection === "thread-pick"
              ? encodeChatModelSelection({
                  modelId: targetModel,
                  provider: target.provider,
                })
              : null,
          chatReasoningEffort: effort === "default" ? null : effort,
          webSearchEnabled: tools === "extended",
        })
        .where(eq(chatThreads.id, threadId));

      return { originRequests, compactionRequests };
    });

    const second = await openSession({
      caching,
      endpoint: target,
      threadId,
      tools,
    });
    try {
      replay.serve(
        attempt === "fallback"
          ? silentAnswerOf(target.provider, second.answer)
          : second.answer,
      );
      const attached = ATTACHMENTS[attachment];
      if (attached === undefined) {
        await second.client.sendUserMessage(Bun.randomUUIDv7(), "Thanks", {
          sendMode,
        });
      } else {
        await second.client.sendUserContent(
          Bun.randomUUIDv7(),
          [
            { type: "text", content: "Read this." },
            await composerAttachmentPart(attached),
          ],
          { sendMode },
        );
      }
      await second.harness.expectSoundWebClient({
        client: second.client,
        threadId,
      });
      const storedMessages = await second.harness.readThreadMessages(threadId);
      const targetRequests = [...second.seam.sentRequests()];
      const checkpoints = await testDb
        .select({ id: chatThreadCompactions.id })
        .from(chatThreadCompactions)
        .where(eq(chatThreadCompactions.threadId, threadId));
      return {
        compacted: checkpoints.length > 0,
        partKinds: new Set<string>(
          storedMessages.flatMap(({ parts }) => parts.map(({ type }) => type)),
        ),
        sent: [
          ...prepared.originRequests,
          ...prepared.compactionRequests,
          ...targetRequests,
        ],
        targetRequests,
      };
    } finally {
      await second.close();
    }
  });

const conversations = new Map<string, Promise<Conversation>>();
/** A combination's conversation, run once for every test that reads it. */
const conversationOf = async (
  combination: ChatCombination,
): Promise<Conversation> => {
  const key = combinationKey(combination);
  const known = conversations.get(key);
  if (known !== undefined) {
    return await known;
  }
  const running = converse(combination);
  conversations.set(key, running);
  return await running;
};

const unique = (lines: readonly string[]): string[] => [...new Set(lines)];

const parsedBody = (request: ReplayedRequest): Record<string, unknown> => {
  const body: unknown = JSON.parse(request.body);
  return isRecord(body) ? body : panic("A provider request body is an object");
};

/** The requests the chat model answered, rather than side calls. */
const chatRequestsOf = (sent: readonly ReplayedRequest[]) =>
  sent.filter(({ exchange }) => typeof exchange === "number");

/** Every rule a combination's requests break. */
const findingsOf = async (combination: ChatCombination): Promise<string[]> => {
  const { sent, targetRequests } = await conversationOf(combination);
  return unique([
    ...sent.flatMap((request) => findProviderRuleViolations(request)),
    ...chatRequestsOf(targetRequests).flatMap((request) =>
      findForeignRequestArtifacts({
        body: parsedBody(request),
        origin: combination.origin.provider,
        target: combination.target.provider,
      }),
    ),
  ]);
};

/** The part kind an attachment is stored as. */
const ATTACHMENT_PART_KIND = {
  none: undefined,
  image: "image",
  pdf: "document",
  text: "document",
  office: "document",
} as const satisfies Record<AttachmentKind, ChatPart["type"] | undefined>;

/** Every string a request's tool declarations name a tool with. */
const declaredToolNamesOf = (tools: readonly unknown[]): Set<string> => {
  const names = new Set<string>();
  const visit = (value: unknown) => {
    if (isUnknownArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "name" && typeof child === "string") {
        names.add(child);
      } else {
        visit(child);
      }
    }
  };
  visit(tools);
  return names;
};

const coveredKeys = (record: Readonly<Record<string, Coverage>>): string[] =>
  Object.entries(record)
    .flatMap(([key, coverage]) => ("covered" in coverage ? [key] : []))
    .toSorted();

/**
 * A user message's text as the stored thread reloads it: the send path
 * normalizes the editor's HTML to Markdown (`normalizeChatMessageHtml`), so
 * raw text sent here reloads trimmed and escaped (" !" as "!", "*" as "\\*").
 * The editor sends HTML, so the page never shows the difference.
 */
const isUserTextNormalization = ({ detail, oracle }: OracleViolation) => {
  const live: unknown = isRecord(detail) ? detail["live"] : undefined;
  return (
    oracle === CHAT_ORACLE.liveEqualsReload &&
    isRecord(live) &&
    live["role"] === "user"
  );
};

/**
 * What a fresh thread's first turn with `text` on `endpoint` breaks, once the
 * turn has settled, so nothing of it reaches a later turn's requests.
 */
const turnViolations = async (
  endpoint: ModelEndpoint,
  text: string,
): Promise<string[]> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  replay.forgetSignedCalls();
  const session = await openSession({
    caching: "off",
    endpoint,
    threadId,
    tools: "default",
  });
  try {
    replay.serve(session.answer);
    await session.client.sendUserMessage(Bun.randomUUIDv7(), text);
    const threadViolations = await session.harness.checkWebClient({
      client: session.client,
      threadId,
    });
    return unique([
      ...session.seam
        .sentRequests()
        .flatMap((request) => findProviderRuleViolations(request)),
      ...threadViolations
        .filter((violation) => !isUserTextNormalization(violation))
        .map((violation) => JSON.stringify(violation)),
    ]);
  } finally {
    await session.close();
  }
};

/** One conversation's turns take a few seconds; retried failures wait out
 *  each SDK's backoff. */
const CONVERSATION_TIMEOUT_MS = 60_000;

// --- Tests --------------------------------------------------------------------

const checkImageRequest = async ({
  provider,
  modelId,
  status,
}: {
  provider: TanStackAIProvider;
  modelId: string;
  status: "supported" | "unlisted";
}) => {
  expect(getModelImageInputCapability({ modelId, provider })).toBe(
    status === "unlisted" ? undefined : status,
  );
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  const session = await openSession({
    caching: "off",
    endpoint: { provider, slot: "recorded" },
    modelId,
    threadId,
    tools: "default",
  });
  const logs = installRecordingLogger();
  try {
    replay.serve(session.answer);
    const part = await composerAttachmentPart(ATTACHMENTS.image);
    if (part.type !== "image" || part.source.type !== "url") {
      panic("The composer image fixture must hold an inline image URL");
    }
    const payload = part.source.value.slice(part.source.value.indexOf(",") + 1);
    await session.client.sendUserContent(Bun.randomUUIDv7(), [
      { type: "text", content: "Read this image." },
      part,
    ]);
    await session.harness.expectSoundWebClient({
      client: session.client,
      threadId,
    });
    const requests = chatRequestsOf(session.seam.sentRequests());
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.some(({ body }) => body.includes(payload))).toBe(true);
    expect(requests.flatMap(findProviderRuleViolations)).toEqual([]);
    const unknownLogs = logs.records.filter(
      ({ message }) => message === "ai.image_capability_unknown",
    );
    if (status === "unlisted") {
      expect(unknownLogs.length).toBeGreaterThan(0);
      expect(
        unknownLogs.every(
          ({ attributes }) =>
            attributes?.["provider"] === provider &&
            attributes["image_capability_unknown"] === true &&
            attributes["reason"] === "unlisted_model",
        ),
      ).toBe(true);
    } else {
      expect(unknownLogs).toEqual([]);
    }
  } finally {
    logs.restore();
    await session.close();
  }
};

const checkImageRefusal = async ({
  provider,
  modelId,
}: {
  provider: TanStackAIProvider;
  modelId: string;
}) => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  const session = await openSession({
    caching: "off",
    endpoint: { provider, slot: "recorded" },
    modelId,
    threadId,
    tools: "default",
  });
  try {
    replay.serve(session.answer);
    const exchanges = session.harness.recordThread(threadId);
    await session.client.sendUserContent(Bun.randomUUIDv7(), [
      { type: "text", content: "Read this image." },
      await composerAttachmentPart(ATTACHMENTS.image),
    ]);
    expect(exchanges).toHaveLength(1);
    const response = exchanges.at(0)?.response;
    expect(response).toMatchObject({ status: 422 });
    expect(JSON.parse(response?.body ?? "null")).toMatchObject({
      code: "image_input_unsupported",
    });
    expect(session.client.runtimeState().hasError).toBe(true);
    expect(session.seam.sentRequests()).toEqual([]);
  } finally {
    await session.close();
  }
};

// The catalog's image capability decides: an unsupported entry refuses before
// dispatch, and a model the catalog does not list is sent and logged. Offered
// models and unlisted choices both go through the real send path and adapter.
describe("image input at the provider request boundary", () => {
  for (const provider of TANSTACK_AI_PROVIDERS) {
    const models: readonly string[] = BYOK_MODEL_OPTIONS[provider];
    const capable = models.find(
      (modelId) =>
        getModelImageInputCapability({ modelId, provider }) === "supported",
    );
    if (capable === undefined) {
      panic(`The ${provider} image matrix needs an image-capable model`);
    }
    for (const imageModel of [
      { status: "supported", modelId: capable },
      { status: "unlisted", modelId: "stella-cassette-unknown-vision-model" },
    ] as const) {
      test(
        `${provider}/${imageModel.status}: image input sends a valid request`,
        async () => await checkImageRequest({ provider, ...imageModel }),
        propertyTestTimeout(CONVERSATION_TIMEOUT_MS),
      );
    }

    for (const modelId of models.filter(
      (candidate) =>
        getModelImageInputCapability({ modelId: candidate, provider }) ===
        "unsupported",
    )) {
      test(
        `${provider}/${modelId}: a model without image input refuses before any provider request`,
        async () => await checkImageRefusal({ provider, modelId }),
        propertyTestTimeout(CONVERSATION_TIMEOUT_MS),
      );
    }
  }

  test(
    "Bedrock re-encodes an image above its provider cap before sending",
    async () => {
      const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
      seededThreadIds.push(threadId);
      const session = await openSession({
        caching: "off",
        endpoint: { provider: "bedrock", slot: "recorded" },
        threadId,
        tools: "default",
      });
      try {
        replay.serve(session.answer);
        const original = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
          "base64",
        );
        // Trailing padding retains decodable pixels while making the encoded
        // image exceed Bedrock's cap within the upload limit.
        const oversized = Buffer.alloc(BEDROCK_IMAGE_MAX_BYTES + 1);
        original.copy(oversized);
        expect(oversized.byteLength).toBeGreaterThan(BEDROCK_IMAGE_MAX_BYTES);
        expect(oversized.byteLength).toBeLessThan(10 * 1024 * 1024);
        await session.client.sendUserContent(Bun.randomUUIDv7(), [
          { type: "text", content: "Read this image." },
          {
            type: "image",
            source: {
              type: "url",
              value: toDataUrl(oversized, "image/png"),
              mimeType: "image/png",
            },
            metadata: { filename: "oversized.png" },
          },
        ]);
        await session.harness.expectSoundWebClient({
          client: session.client,
          threadId,
        });
        const requests = chatRequestsOf(session.seam.sentRequests());
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.flatMap(findProviderRuleViolations)).toEqual([]);
        const images: Record<string, unknown>[] = [];
        const visit = (value: unknown): void => {
          if (isUnknownArray(value)) {
            for (const item of value) {
              visit(item);
            }
            return;
          }
          if (!isRecord(value)) {
            return;
          }
          const image = value["image"];
          if (isRecord(image)) {
            images.push(image);
          }
          for (const item of Object.values(value)) {
            visit(item);
          }
        };
        for (const request of requests) {
          visit(parsedBody(request));
        }
        expect(images.length).toBeGreaterThan(0);
        for (const image of images) {
          expect(image["format"]).toBe("webp");
          const source = image["source"];
          if (!isRecord(source) || typeof source["bytes"] !== "string") {
            panic("A Bedrock image request must hold base64 image bytes");
          }
          const encoded = Buffer.from(source["bytes"], "base64");
          expect(encoded.byteLength).toBeLessThanOrEqual(
            BEDROCK_IMAGE_MAX_BYTES,
          );
          expect(await new Bun.Image(encoded).metadata()).toMatchObject({
            width: 1,
            height: 1,
          });
        }
      } finally {
        await session.close();
      }
    },
    propertyTestTimeout(CONVERSATION_TIMEOUT_MS),
  );
});

describe(`chat requests: ${String(combinations.included.length)} combinations the product can produce (${String(combinations.total - combinations.included.length)} excluded by a production predicate); ${runPlan.mode}: ${String(selectedCombinations.length)} run`, () => {
  test("every combination is producible or excluded by a named predicate", () => {
    expect(
      [...combinations.excluded.keys()].filter((name) => name === ""),
    ).toEqual([]);
    expect(
      combinations.included.length +
        [...combinations.excluded.values()].reduce(
          (sum, count) => sum + count,
          0,
        ),
    ).toBe(combinations.total);
  });

  test("every coverage entry states how it is covered", () => {
    expect(
      [REQUEST_OPTION_COVERAGE, PART_KIND_COVERAGE, TOOL_KIND_COVERAGE].flatMap(
        (record) =>
          Object.entries(record).filter(
            ([, coverage]) => Object.values(coverage).join("").trim() === "",
          ),
      ),
    ).toEqual([]);
  });

  test("every value no conversation can send is one the production tables never send", () => {
    // Parts: exactly the kinds the part policy keeps off the provider.
    expect(
      Object.entries(PART_KIND_COVERAGE)
        .filter(([, coverage]) => "neverSent" in coverage)
        .map(([kind]) => kind)
        .toSorted(),
    ).toEqual(
      Object.keys(PART_KIND_COVERAGE)
        .filter(
          (kind) =>
            !isProviderVisibleChatPart(asTestRaw<ChatPart>({ type: kind })),
        )
        .toSorted(),
    );
    // Tools: exactly the kinds no tool table gives any tool.
    const tabled = new Set<string>([
      ...Object.values(BUILT_IN_CHAT_TOOL_POLICY_KINDS),
      ...Object.values(MCP_CHAT_TOOL_POLICY_KINDS),
      "external",
    ]);
    expect(
      Object.entries(TOOL_KIND_COVERAGE)
        .filter(([, coverage]) => "neverSent" in coverage)
        .map(([kind]) => kind),
    ).toEqual(
      Object.keys(TOOL_KIND_COVERAGE).filter((kind) => !tabled.has(kind)),
    );
  });

  for (const combination of selectedCombinations) {
    const key = combinationKey(combination);
    const known = knownFindingOf(combination);
    const check = async () => {
      const conversation = await conversationOf(combination);
      // The thread holds what the combination says it does.
      const { partKinds } = conversation;
      expect({
        attachment: [...partKinds].filter(
          (kind) => kind === "image" || kind === "document",
        ),
        compacted: conversation.compacted,
        // The fallback's request went to the organization's reasoning
        // model.
        fallback: conversation.targetRequests.some(
          ({ exchange, model }) =>
            exchange === "side" &&
            model ===
              reasoningModelOf(
                combination.target.provider,
                modelOf(cassettes, combination.target),
              ),
        ),
        reasoning: partKinds.has("thinking"),
        structuredOutput: partKinds.has("structured-output"),
      }).toEqual({
        attachment: [ATTACHMENT_PART_KIND[combination.attachment]].filter(
          (kind) => kind !== undefined,
        ),
        compacted: combination.compaction === "compacted",
        fallback: combination.attempt === "fallback",
        reasoning: combination.history === "reasoning",
        structuredOutput: combination.stored === "structured-output",
      });
      expect(await findingsOf(combination)).toEqual([]);
    };
    if (known === undefined) {
      test(
        `${key}: every request holds to the provider's rules`,
        check,
        propertyTestTimeout(CONVERSATION_TIMEOUT_MS),
      );
    } else {
      test.failing(
        `${key}: known finding: ${known}`,
        check,
        propertyTestTimeout(CONVERSATION_TIMEOUT_MS),
      );
    }
  }

  // A shard of the nightly run holds only some kinds; the all-pairs run
  // holds every one.
  test.skipIf(runPlan.mode !== "all-pairs")(
    "the conversations reach exactly the part and tool kinds the coverage records call covered",
    async () => {
      const partKinds = new Set<string>();
      const toolKinds = new Set<string>();
      for (const combination of selectedCombinations) {
        if (knownFindingOf(combination) !== undefined) {
          continue;
        }
        const conversation = await conversationOf(combination);
        for (const kind of conversation.partKinds) {
          partKinds.add(kind);
        }
        for (const request of chatRequestsOf(conversation.targetRequests)) {
          for (const name of declaredToolNamesOf(
            WIRE_PROMPT_SECTIONS[combination.target.provider](
              parsedBody(request),
            ).tools,
          )) {
            const kind = declaredToolKindOf(name);
            if (kind !== undefined) {
              toolKinds.add(kind);
            }
          }
        }
      }
      expect([...partKinds].toSorted()).toEqual(
        coveredKeys(PART_KIND_COVERAGE),
      );
      expect([...toolKinds].toSorted()).toEqual(
        coveredKeys(TOOL_KIND_COVERAGE),
      );
    },
    propertyTestTimeout(CONVERSATION_TIMEOUT_MS),
  );

  for (const provider of TANSTACK_AI_PROVIDERS) {
    const baseline = baselineOf(provider);

    test(
      `${provider}: the conversation reaches its chat endpoint on every turn, and every accepted deviation is still sent`,
      async () => {
        const { sent } = await conversationOf(baseline);
        // The first turn, the continuation after the tool result, and the
        // later turn each reached the provider's chat endpoint.
        expect(chatRequestsOf(sent).map(requestSchemaIdOf)).toEqual(
          Array.from({ length: 3 }, () => PROVIDER_CHAT_SCHEMA[provider]),
        );
        const raw = unique(
          sent.flatMap((request) => findRequestSchemaViolations(request)),
        );
        expect(
          ACCEPTED_BEYOND_SCHEMA.filter(
            ({ schema, violation }) =>
              schema === PROVIDER_CHAT_SCHEMA[provider] &&
              !raw.includes(violation),
          ),
        ).toEqual([]);
      },
      propertyTestTimeout(CONVERSATION_TIMEOUT_MS),
    );

    test(
      `${provider}: a turn with any user text holds to the provider's rules`,
      async () => {
        await fc.assert(
          fc.asyncProperty(
            fc
              .string({ minLength: 1, maxLength: 400, unit: "grapheme" })
              .filter((text) => text.trim() !== ""),
            async (text) => {
              expect(
                await turnViolations({ provider, slot: "recorded" }, text),
              ).toEqual([]);
            },
          ),
          propertyConfig({ numRuns: 2 }),
        );
      },
      propertyTestTimeout(CONVERSATION_TIMEOUT_MS),
    );
  }

  // The inventory is the paths the all-pairs run sends, by target provider.
  if (runPlan.mode === "all-pairs") {
    for (const provider of TANSTACK_AI_PROVIDERS) {
      test(
        `${provider}: the request paths the conversations send are the committed inventory`,
        async () => {
          const paths = new Set<string>();
          for (const combination of selectedCombinations) {
            if (
              combination.target.provider !== provider ||
              knownFindingOf(combination) !== undefined
            ) {
              continue;
            }
            const { targetRequests } = await conversationOf(combination);
            for (const request of targetRequests) {
              for (const entry of requestPathsOf(
                parsedBody(request),
                OPAQUE_REQUEST_PATHS[provider],
              )) {
                paths.add(entry);
              }
            }
          }
          if (updatingRequestPaths()) {
            writeRequestPaths(provider, paths);
            return;
          }
          expect(
            findRequestPathDrift({
              inventory: readRequestPathInventory()[provider] ?? [],
              provider,
              sent: paths,
            }),
          ).toEqual([]);
        },
        propertyTestTimeout(CONVERSATION_TIMEOUT_MS),
      );
    }
  }
});
