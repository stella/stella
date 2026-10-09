import type { ModelMessage } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ModelRole } from "@stll/ai-catalog";
import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_TOOL_POLICY_KIND } from "@stll/api-contract";
import { CHAT_PROMPT_IMPROVEMENT_STRATEGIES } from "@stll/api-contract/chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { toChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import {
  compactChatMessagesForModel,
  compactModelMessagesForModel,
} from "@/api/handlers/chat/compaction";
import { generateThreadTitle } from "@/api/handlers/chat/generate-thread-title";
import getSuggestedPrompts from "@/api/handlers/chat/get-suggested-prompts";
import improvePrompt from "@/api/handlers/chat/improve-prompt";
import { runSubagent } from "@/api/handlers/chat/subagent-runner";
import { createSuggestThreadTitle } from "@/api/handlers/chat/suggest-thread-title";
import { createChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { generateThreadRecapText } from "@/api/handlers/chat/thread-recap";
import { applyChatToolPolicy } from "@/api/handlers/chat/tools/tool-policy";
import type { ChatMessage } from "@/api/handlers/chat/types";
import createSkillComment from "@/api/handlers/skills/comments/create";
import generateSkillDraft from "@/api/handlers/skills/drafts/generate";
import createProposalFromComments from "@/api/handlers/skills/proposals/from-comments/create";
import createSkillResource from "@/api/handlers/skills/resources/create";
import rewriteSkillResource from "@/api/handlers/skills/resources/rewrite";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { isChatModelReasoningEffortAvailable } from "@/api/lib/chat-model-selection";
import { runChatThreadCompaction } from "@/api/lib/chat/thread-compaction";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  insertTestSkill,
  latestTestSkillRevisionId,
} from "@/api/tests/helpers/agent-skill-db";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import {
  CACHING_SETTINGS,
  endpointKey,
  enumerateEndpoints,
  EFFORT_CHOICES,
  modelOf,
  SEND_MODES,
} from "@/api/tests/helpers/provider-request-matrix";
import type {
  CachingSetting,
  EffortChoice,
  ModelEndpoint,
  SendMode,
} from "@/api/tests/helpers/provider-request-matrix";
import { findProviderRuleViolations } from "@/api/tests/helpers/provider-request-schema";
import {
  cassetteFor,
  loadProviderWireCassettes,
  WIRE_TOOL_NAME,
} from "@/api/tests/helpers/provider-wire-cassette";
import {
  wireOrgAIConfig,
  wireTool,
} from "@/api/tests/helpers/provider-wire-contract";
import { installProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import type {
  ProviderWireReplay,
  ReplayedRequest,
} from "@/api/tests/helpers/provider-wire-replay";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Every provider request the chat surface builds besides the chat turn
// (`provider-request-schemas.integration.test.ts`), each through the
// production function that builds it, with the organization's real adapter
// and a `fetch` that captures the request and answers from a recorded
// response. No request leaves the process.
//
// What is guaranteed:
// - Every request builder of the chat surface is in `ROLE_REQUESTS`, keyed by
//   a union: a source scan fails when a file calls a model helper and is
//   neither listed here nor named as outside the chat surface.
// - Every combination of builder, provider and model, caching setting (where
//   the builder takes one), reasoning effort (where it takes one and the
//   model offers it) and send mode (where it crosses the third-party
//   boundary) is enumerated, and every one runs (a few seconds in
//   all).
// - Every request those builders send holds to the provider's published
//   request schema and documented rules.
//
// What is not: the answers (a structured-output request gets a recorded text
// stream, so its call fails after the request is captured), and anything the
// provider refuses that its schema and documentation do not state.

const cassettes = loadProviderWireCassettes();

let testDb: TestDatabase;
let ids: TestIds;
let replay: ProviderWireReplay;
let previousMockAI: typeof env.USE_MOCK_AI;
let previousBedrockEndpoint: string | undefined;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  previousMockAI = env.USE_MOCK_AI;
  env.USE_MOCK_AI = false;
  previousBedrockEndpoint = process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
  process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] =
    "https://bedrock-runtime.us-east-1.amazonaws.com.cassette.invalid";
  replay = installProviderWireReplay();
});

afterAll(async () => {
  replay.restore();
  env.USE_MOCK_AI = previousMockAI;
  if (previousBedrockEndpoint === undefined) {
    delete process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
  } else {
    process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] = previousBedrockEndpoint;
  }
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

const safeDbOf = (): SafeDb =>
  asTestRaw<SafeDb>(
    createSafeDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );

/** What one run of a builder is handed. */
type RoleRun = {
  caching: boolean;
  effort: EffortChoice;
  orgAIConfig: OrgAIConfig;
  sendMode: SendMode;
};

/** The third-party boundary a turn of `run`'s send mode crosses. */
const boundaryOf = (run: RoleRun) =>
  createChatThirdPartyBoundary({
    anonymizationScopeId: Bun.randomUUIDv7(),
    organizationId: ids.orgA,
    scopedDb: asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
    ),
    sendMode: run.sendMode,
    threadRestorations: [],
  });

/** A handler context for the organization's owner. */
const handlerContext = (
  run: RoleRun,
  fields: { body?: unknown; params?: unknown; query?: unknown },
) =>
  createTestHandlerContext({
    recordAuditEvent: auditRecorderDouble(),
    ...fields,
    memberRole: sessionMemberRole("owner"),
    orgAIConfig: run.orgAIConfig,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    managedAIResidency: "eu" as const,
    promptCachingEnabled: run.caching,
    request: new Request("http://localhost/v1/chat"),
    safeDb: safeDbOf(),
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
  });

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

/** A thread of `TRANSCRIPT`, as the send path stores one. */
const seedThread = async (): Promise<SafeId<"chatThread">> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "New chat",
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

const effortOf = (effort: EffortChoice) =>
  effort === "default" ? undefined : effort;

const noAudit = async () => await Promise.resolve();

/** A skill of the organization's owner, with its first revision. */
const seedSkill = async () => {
  const skillId = await insertTestSkill(testDb, {
    organizationId: ids.orgA,
    userId: ids.userA1,
  });
  return {
    revisionId: await latestTestSkillRevisionId(testDb, skillId),
    skillId,
  };
};

/**
 * Every request builder of the chat surface other than the chat turn, keyed
 * by name: the file that builds it, its model role, which request settings
 * it reads, and how to run it through production code.
 */
const ROLE_REQUESTS = {
  "thread-title": {
    file: "handlers/chat/generate-thread-title.ts",
    role: "fast",
    settings: { caching: true, effort: false, sendMode: false },
    run: async (run) => {
      const threadId = await seedThread();
      const [first, second] = chatMessagesOf(TRANSCRIPT);
      const user = first ?? panic("The transcript opens with a user message");
      const assistant = second ?? panic("The transcript answers it");
      await generateThreadTitle({
        indexThread: async () => await Promise.resolve(),
        initialTitle: "New chat",
        messages: [user, assistant],
        organizationId: ids.orgA,
        orgAIConfig: run.orgAIConfig,
        managedAIResidency: "eu" as const,
        promptCachingEnabled: run.caching,
        recordAuditEvent: noAudit,
        safeDb: safeDbOf(),
        threadId,
        threadWorkspaceId: null,
        userId: ids.userA1,
      });
    },
  },
  "suggested-title": {
    file: "handlers/chat/suggest-thread-title.ts",
    role: "fast",
    settings: { caching: true, effort: false, sendMode: false },
    run: async (run) => {
      const handler = createSuggestThreadTitle();
      await handler.handler(
        asTestRaw<Parameters<typeof handler.handler>[0]>(
          handlerContext(run, {
            params: { threadId: await seedThread() },
            query: {},
          }),
        ),
      );
    },
  },
  "follow-up-suggestions": {
    file: "handlers/chat/get-suggested-prompts.ts",
    role: "fast",
    settings: { caching: true, effort: false, sendMode: false },
    run: async (run) => {
      await getSuggestedPrompts.handler(
        asTestRaw<Parameters<typeof getSuggestedPrompts.handler>[0]>(
          handlerContext(run, {
            params: { threadId: await seedThread() },
            query: {},
          }),
        ),
      );
    },
  },
  "thread-recap": {
    file: "handlers/chat/thread-recap.ts",
    role: "fast",
    settings: { caching: true, effort: false, sendMode: false },
    run: async (run) => {
      await generateThreadRecapText({
        messages: chatMessagesOf(TRANSCRIPT),
        organizationId: ids.orgA,
        admission: testModelAdmission(ids.orgA),
        orgAIConfig: run.orgAIConfig,
        managedAIResidency: "eu" as const,
        promptCachingEnabled: run.caching,
        threadId: await seedThread(),
        workspaceId: null,
      });
    },
  },
  "improve-prompt": {
    file: "handlers/chat/improve-prompt.ts",
    role: "fast",
    settings: { caching: true, effort: false, sendMode: true },
    run: async (run) => {
      for (const strategy of CHAT_PROMPT_IMPROVEMENT_STRATEGIES) {
        await improvePrompt.handler(
          asTestRaw<Parameters<typeof improvePrompt.handler>[0]>(
            handlerContext(run, {
              body: {
                prompt: "Draft an NDA for Acme",
                sendMode: run.sendMode,
                strategy,
              },
            }),
          ),
        );
      }
    },
  },
  "pre-stream-compaction": {
    file: "handlers/chat/compaction.ts",
    role: "chat",
    settings: { caching: false, effort: true, sendMode: true },
    run: async (run) => {
      await compactChatMessagesForModel({
        abortSignal: AbortSignal.timeout(ROLE_TIMEOUT_MS),
        boundary: boundaryOf(run),
        messages: chatMessagesOf(TRANSCRIPT),
        organizationId: ids.orgA,
        admission: testModelAdmission(ids.orgA),
        orgAIConfig: run.orgAIConfig,
        managedAIResidency: "eu" as const,
        preserveTokens: 1,
        reasoningEffort: effortOf(run.effort),
        tenantWorkspaceIds: [],
        triggerTokens: 1,
      });
    },
  },
  "step-compaction": {
    file: "handlers/chat/compaction.ts",
    role: "chat",
    settings: { caching: false, effort: false, sendMode: false },
    run: async (run) => {
      await compactModelMessagesForModel({
        abortSignal: AbortSignal.timeout(ROLE_TIMEOUT_MS),
        messages: TRANSCRIPT.map((content, index): ModelMessage => ({
          content,
          role: index % 2 === 0 ? "user" : "assistant",
        })),
        organizationId: ids.orgA,
        admission: testModelAdmission(ids.orgA),
        orgAIConfig: run.orgAIConfig,
        managedAIResidency: "eu" as const,
        preserveTokens: 1,
        role: "chat",
        tenantWorkspaceIds: [],
        triggerTokens: 1,
      });
    },
  },
  "thread-compaction": {
    file: "lib/chat/thread-compaction.ts",
    role: "chat",
    settings: { caching: false, effort: true, sendMode: false },
    run: async (run) => {
      await runChatThreadCompaction({
        abortSignal: AbortSignal.timeout(ROLE_TIMEOUT_MS),
        dataWorkspaceIds: [],
        orgAIConfig: run.orgAIConfig,
        managedAIResidency: "eu" as const,
        organizationId: ids.orgA,
        admission: testModelAdmission(ids.orgA),
        preserveTokens: 1,
        reasoningEffort: effortOf(run.effort),
        safeDb: safeDbOf(),
        threadId: await seedThread(),
        triggerTokens: 1,
      });
    },
  },
  subagent: {
    file: "handlers/chat/subagent-runner.ts",
    role: "fast",
    settings: { caching: false, effort: false, sendMode: true },
    run: async (run) => {
      await runSubagent({
        abortSignal: AbortSignal.timeout(ROLE_TIMEOUT_MS),
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
        orgAIConfig: run.orgAIConfig,
        managedAIResidency: "eu" as const,
        role: "fast",
        systemSafe: "Answer briefly.",
        systemUntrusted: "Return the clause text.",
        tenantWorkspaceIds: [],
        thirdPartyBoundary: boundaryOf(run),
        tools: {
          [WIRE_TOOL_NAME]: applyChatToolPolicy(
            wireTool().server(
              async ({ name }) => await Promise.resolve({ deleted: name }),
            ),
            CHAT_TOOL_POLICY_KIND.internal,
          ),
        },
      });
    },
  },
  "skill-draft": {
    file: "handlers/skills/drafts/generate.ts",
    role: "fast",
    settings: { caching: true, effort: false, sendMode: false },
    run: async (run) => {
      await generateSkillDraft.handler(
        asTestRaw<Parameters<typeof generateSkillDraft.handler>[0]>(
          handlerContext(run, {
            body: { intent: "Review an NDA against our playbook." },
          }),
        ),
      );
    },
  },
  "skill-proposal": {
    file: "handlers/skills/proposals/from-comments/create.ts",
    role: "fast",
    settings: { caching: true, effort: false, sendMode: false },
    run: async (run) => {
      const { revisionId, skillId } = await seedSkill();
      await createSkillComment.handler(
        asTestRaw<Parameters<typeof createSkillComment.handler>[0]>(
          handlerContext(run, {
            body: {
              body: "Name the playbook.",
              rangeEnd: 6,
              rangeStart: 0,
              revisionId,
            },
            params: { skillId },
          }),
        ),
      );
      await createProposalFromComments.handler(
        asTestRaw<Parameters<typeof createProposalFromComments.handler>[0]>(
          handlerContext(run, { body: {}, params: { skillId } }),
        ),
      );
    },
  },
  "skill-resource-rewrite": {
    file: "handlers/skills/resources/rewrite.ts",
    role: "fast",
    settings: { caching: true, effort: false, sendMode: false },
    run: async (run) => {
      const { skillId } = await seedSkill();
      await createSkillResource.handler(
        asTestRaw<Parameters<typeof createSkillResource.handler>[0]>(
          handlerContext(run, {
            body: { content: "Check the term.", path: "notes.md" },
            params: { skillId },
          }),
        ),
      );
      await rewriteSkillResource.handler(
        asTestRaw<Parameters<typeof rewriteSkillResource.handler>[0]>(
          handlerContext(run, {
            body: { path: "notes.md", prompt: "Make it a checklist." },
            params: { skillId },
          }),
        ),
      );
    },
  },
} as const satisfies Record<
  string,
  {
    file: string;
    role: ModelRole;
    run: (run: RoleRun) => Promise<void>;
    settings: { caching: boolean; effort: boolean; sendMode: boolean };
  }
>;

type RoleRequestName = keyof typeof ROLE_REQUESTS;

/**
 * Every model role, by what builds its requests on the chat surface. A role
 * no chat-surface builder uses is never sent from it.
 */
const MODEL_ROLE_COVERAGE = {
  chat: { covered: "The chat turn, and the compaction summaries." },
  fast: { covered: "Titles, suggestions, recaps, subagents and skills." },
  pdf: {
    neverSent:
      "No chat-surface builder uses it; document reviews and workflows do.",
  },
  reasoning: { covered: "The chat attempt's fallback (the chat test)." },
} as const satisfies Record<
  ModelRole,
  { covered: string } | { neverSent: string }
>;

/** The roles the chat turn test's attempts run on (`ChatAttemptRole`). */
const CHAT_ATTEMPT_ROLES: readonly ModelRole[] = ["chat", "reasoning"];
const ROLE_REQUEST_NAMES = Object.keys(ROLE_REQUESTS).filter(
  (name): name is RoleRequestName => name in ROLE_REQUESTS,
);

/**
 * Files that call a model helper and are not part of the chat surface, each
 * with the feature they serve. A file that calls one and is in neither list
 * fails the scan below.
 */
const OUTSIDE_THE_CHAT_SURFACE: Readonly<Record<string, string>> = {
  "handlers/ai-autocomplete/stream.ts": "editor autocomplete",
  "handlers/case-law/analysis/generate.ts": "case-law analysis",
  "handlers/case-law/analysis/significance-run.ts": "case-law analysis",
  "handlers/case-law/decisions/search-expand.ts": "case-law search",
  "handlers/case-law/decisions/search-refine.ts": "case-law search",
  "handlers/case-law/polarity/llm-classifier.ts": "case-law citator",
  "handlers/clauses/rewrite.ts": "clause library",
  "handlers/contacts/extract-procuracao.ts": "contacts",
  "handlers/document-reviews/reference-positions.ts": "document review",
  "handlers/entities/placements/suggest.ts": "entity placement",
  "handlers/playbooks/derive-ask.ts": "playbooks",
  "handlers/search/ai.ts": "search",
  "handlers/templates/prefill.ts": "templates",
  "handlers/time-entries/polish-narrative.ts": "time entries",
  "lib/ai-change-summary.ts": "document change summaries",
  "lib/case-law/research-answer-runner.ts": "case-law research",
  "lib/document-review/parties.ts": "document review",
  "lib/document-translation/ai.ts": "document translation",
  "lib/docx/ai-field-generator.ts": "document fields",
  "lib/properties/column-prompt-suggestion.ts": "matter properties",
  "lib/scheduler/tasks/memory-extractor.ts":
    "AI memory (a scheduled job over compaction summaries)",
  "lib/scouts/document-deadlines.ts": "deadline scouting",
  "lib/workflow/ai-generate-batch.ts": "workflows",
  "lib/workflow/verdict-engine.ts": "workflows",
};

/** Files the chat turn test covers, and the model helpers themselves. */
const CHAT_TURN_FILES: ReadonlySet<string> = new Set([
  "handlers/chat/stream-chat.ts",
  "handlers/chat/tools/spawn-subagents-tool.ts",
  "lib/tanstack-ai-generate.ts",
]);

const MODEL_HELPER_CALL =
  /\b(?:generateTanStackTextForRole|generateTanStackObjectForRole|streamTanStackTextForRole|streamTanStackObjectForRole|streamChatChunks|generateChatObject|streamChatObject|generateTanStackChatObject|streamTanStackChatRun|runSubagent)\(/u;

const SOURCE_ROOT = path.resolve(import.meta.dir, "../..");

const sourceFilesUnder = (directory: string): string[] =>
  readdirSync(path.join(SOURCE_ROOT, directory), {
    recursive: true,
    withFileTypes: true,
  }).flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      return [];
    }
    const file = path.relative(
      SOURCE_ROOT,
      path.join(entry.parentPath, entry.name),
    );
    return file.includes(".test.") || file.startsWith("tests/") ? [] : [file];
  });

// --- The combinations ---------------------------------------------------------

type RoleCombination = {
  caching: CachingSetting;
  effort: EffortChoice;
  endpoint: ModelEndpoint;
  request: RoleRequestName;
  sendMode: SendMode;
};

const roleCombinationKey = (combination: RoleCombination): string =>
  `${combination.request} on ${endpointKey(combination.endpoint)}; caching ${combination.caching}, effort ${combination.effort}, ${combination.sendMode}`;

const endpoints = enumerateEndpoints(cassettes);

/** The production predicate that says the product cannot produce
 *  `combination`, if one does. */
const roleRefusal = (combination: RoleCombination): string | undefined => {
  if (
    combination.effort !== "default" &&
    !isChatModelReasoningEffortAvailable({
      modelId: modelOf(cassettes, combination.endpoint),
      provider: combination.endpoint.provider,
      reasoningEffort: combination.effort,
    })
  ) {
    return "effort: isChatModelReasoningEffortAvailable";
  }
  if (
    combination.request === "improve-prompt" &&
    combination.sendMode === CHAT_SEND_MODE.anonymized
  ) {
    return "sendMode: improvePrompt refuses an anonymized prompt";
  }
  return undefined;
};

const roleCombinations = (() => {
  const included: RoleCombination[] = [];
  const excluded: { combination: RoleCombination; predicate: string }[] = [];
  for (const request of ROLE_REQUEST_NAMES) {
    const { settings } = ROLE_REQUESTS[request];
    for (const endpoint of endpoints) {
      for (const caching of settings.caching
        ? CACHING_SETTINGS
        : (["off"] as const)) {
        for (const effort of settings.effort
          ? EFFORT_CHOICES
          : (["default"] as const)) {
          for (const sendMode of settings.sendMode
            ? SEND_MODES
            : (["rawOverride"] as const)) {
            const combination = {
              caching,
              effort,
              endpoint,
              request,
              sendMode,
            };
            const refused = roleRefusal(combination);
            if (refused === undefined) {
              included.push(combination);
            } else {
              excluded.push({ combination, predicate: refused });
            }
          }
        }
      }
    }
  }
  return { excluded, included };
})();

/** The requests a combination's run sends, each answered with its
 *  provider's recorded text answer. */
const requestsOf = async (
  combination: RoleCombination,
): Promise<readonly ReplayedRequest[]> => {
  const model = modelOf(cassettes, combination.endpoint);
  const { provider } = combination.endpoint;
  // Every role of the organization answers from the endpoint's model.
  const orgAIConfig = wireOrgAIConfig({
    apiKey: "cassette-replay-no-credentials",
    chatModel: model,
    provider,
    sideModel: model,
  });
  const answer = cassetteFor(cassettes, provider, "text").exchanges[0];
  replay.takeFindings();
  replay.forgetSignedCalls();
  // No queued model: every request is answered as a side call.
  replay.serve({ exchanges: [], model: "no-queued-model" });
  replay.answerSideCalls(answer);
  try {
    const outcome = await Result.tryPromise(
      async () =>
        await ROLE_REQUESTS[combination.request].run({
          caching: combination.caching === "on",
          effort: combination.effort,
          orgAIConfig,
          sendMode: combination.sendMode,
        }),
    );
    const requests = [...replay.requests()];
    // The answer is a text stream whatever the request asked for, so a
    // builder that reads it as something else fails after its request was
    // captured. One that fails before sending anything is the defect itself.
    if (Result.isError(outcome) && requests.length === 0) {
      return panic(
        `${combination.request} built no request: ${String(outcome.error.cause)}`,
      );
    }
    return requests;
  } finally {
    replay.answerSideCalls(undefined);
    replay.takeFindings();
  }
};

const ROLE_TIMEOUT_MS = 60_000;

// --- Tests --------------------------------------------------------------------

describe(`role requests: ${String(roleCombinations.included.length)} combinations the product can produce (${String(roleCombinations.excluded.length)} excluded by a production predicate); every one runs`, () => {
  test("every file that calls a model helper is a listed builder or outside the chat surface", () => {
    const listed = new Set<string>([
      ...Object.values(ROLE_REQUESTS).map(({ file }) => file),
      ...Object.keys(OUTSIDE_THE_CHAT_SURFACE),
      ...CHAT_TURN_FILES,
    ]);
    const callers = [
      ...sourceFilesUnder("handlers"),
      ...sourceFilesUnder("lib"),
    ]
      .filter((file) =>
        MODEL_HELPER_CALL.test(
          readFileSync(path.join(SOURCE_ROOT, file), "utf-8"),
        ),
      )
      .toSorted();
    expect(callers.filter((file) => !listed.has(file))).toEqual([]);
    // Every listed file still calls one.
    expect(
      [...Object.keys(OUTSIDE_THE_CHAT_SURFACE), ...CHAT_TURN_FILES].filter(
        (file) => !callers.includes(file),
      ),
    ).toEqual([]);
  });

  test("the builders use exactly the model roles the coverage record calls covered", () => {
    expect(
      [
        ...new Set<string>([
          ...Object.values(ROLE_REQUESTS).map(({ role }) => role),
          ...CHAT_ATTEMPT_ROLES,
        ]),
      ].toSorted(),
    ).toEqual(
      Object.entries(MODEL_ROLE_COVERAGE)
        .flatMap(([role, coverage]) => ("covered" in coverage ? [role] : []))
        .toSorted(),
    );
  });

  test("every combination names its builder, and every builder runs", () => {
    expect(
      [
        ...new Set(roleCombinations.included.map(({ request }) => request)),
      ].toSorted(),
    ).toEqual(ROLE_REQUEST_NAMES.toSorted());
  });

  for (const combination of roleCombinations.included) {
    test(
      `${roleCombinationKey(combination)}: every request holds to the provider's rules`,
      async () => {
        const sent = await requestsOf(combination);
        const model = modelOf(cassettes, combination.endpoint);
        // The builder reached the provider, on the endpoint's model.
        expect(sent.length).toBeGreaterThan(0);
        expect([...new Set(sent.map((request) => request.model))]).toEqual([
          model,
        ]);
        expect([
          ...new Set(
            sent.flatMap((request) => findProviderRuleViolations(request)),
          ),
        ]).toEqual([]);
      },
      ROLE_TIMEOUT_MS,
    );
  }
});
