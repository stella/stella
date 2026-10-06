import { toolDefinition } from "@tanstack/ai";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";
import type { TanStackAIProvider } from "@stll/ai-catalog";
import { propertyTestTimeout } from "@stll/property-testing";

import { user as authUser } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  chatThreads,
  featureEnrolments,
  organizationSettings,
  userFiles,
} from "@/api/db/schema";
import type { PracticeJurisdiction } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import type { IncomingUserContext } from "@/api/handlers/chat/chat-schema";
import type { createStellaMcpToolSource } from "@/api/handlers/chat/tools/external-mcp-tools";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  PROVIDER_PROMPT_CACHING,
  promptCachingUsesBreakpoints,
} from "@/api/lib/tanstack-ai-caching";
import type { ProviderPromptCaching } from "@/api/lib/tanstack-ai-caching";
import { isRecord } from "@/api/lib/type-guards";
import {
  createApprovalHarness,
  pendingApprovalCallOf,
} from "@/api/tests/helpers/chat-approval-harness";
import { createPromptPrefixLedger } from "@/api/tests/helpers/chat-prompt-prefix";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  anthropicToolEntriesOf,
  cacheMarkersOf,
  chatPromptBaselineUpdateReason,
  commonPrefixLength,
  estimatedTokens,
  estimatedWireTokens,
  findStablePrefixDrift,
  readChatPromptBaseline,
  systemBlocksOf,
  systemTextOf,
  toolsSectionOf,
  writeStablePrefixTokens,
} from "@/api/tests/helpers/provider-request-cache";
import {
  cassetteForModel,
  modelOf,
  TOOL_SURFACES,
  toolCallAnswerFor,
} from "@/api/tests/helpers/provider-request-matrix";
import type {
  CachingSetting,
  ModelEndpoint,
  ToolSurface,
} from "@/api/tests/helpers/provider-request-matrix";
import {
  cassetteFor,
  loadProviderWireCassettes,
} from "@/api/tests/helpers/provider-wire-cassette";
import {
  wireOrgAIConfig,
  wireSideModel,
} from "@/api/tests/helpers/provider-wire-contract";
import { installProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import type {
  ProviderWireReplay,
  ReplayedRequest,
} from "@/api/tests/helpers/provider-wire-replay";
import {
  replayedHarnessModel,
  WIRE_PROMPT_SECTIONS,
} from "@/api/tests/helpers/replayed-harness-model";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { enrolTimeBilling } from "@/api/tests/helpers/time-billing-enrolment";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// What the chat request builder (`chat-request.ts`) promises each provider's
// prompt cache, held on the request bodies the provider SDKs write. A
// conversation runs through the real send handler and `streamChat` into the
// organization's real adapter, and the provider wire replay captures each
// body, as in `provider-request-schemas.integration.test.ts`; this file runs
// in a process of its own.

const cassettes = loadProviderWireCassettes();

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

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
let replay: ProviderWireReplay;
let fakeS3: FakeS3;
let previousMockAI: typeof env.USE_MOCK_AI;
let previousBedrockEndpoint: string | undefined;
const seededThreadIds: SafeId<"chatThread">[] = [];

/** A member of the organization, as the send path sees them. */
type Member = {
  /** The profile their page sends with each message; none by default. */
  context?: IncomingUserContext | undefined;
  id: SafeId<"user">;
  /** The matter their extended surface puts in context; one they reach. */
  matterId?: SafeId<"workspace"> | undefined;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
};
let firstMember: Member;
let secondMember: Member;

const memberOf = (
  id: SafeId<"user">,
  context?: IncomingUserContext,
): Member => {
  const memberScopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, id),
  );
  return {
    context,
    id,
    safeDb: toSafeDbMock(memberScopedDb),
    scopedDb: memberScopedDb,
  };
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
  firstMember = { id: ids.userA1, safeDb, scopedDb };
  secondMember = memberOf(ids.userA2);
  previousMockAI = env.USE_MOCK_AI;
  env.USE_MOCK_AI = false;
  previousBedrockEndpoint = process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
  process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] =
    "https://bedrock-runtime.us-east-1.amazonaws.com.cassette.invalid";
  fakeS3 = startFakeS3();
  replay = installProviderWireReplay({ passThroughOrigins: [fakeS3.endpoint] });
});

afterAll(async () => {
  replay.restore();
  fakeS3.stop();
  env.USE_MOCK_AI = previousMockAI;
  if (previousBedrockEndpoint === undefined) {
    delete process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
  } else {
    process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] = previousBedrockEndpoint;
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

/** The organization whose chat model is `endpoint`'s (or `chatModel`), with
 *  the provider's other model answering side calls (the thread title). */
const orgConfigOf = (endpoint: ModelEndpoint, chatModel?: string) => {
  const model = chatModel ?? modelOf(cassettes, endpoint);
  return wireOrgAIConfig({
    apiKey: "cassette-replay-no-credentials",
    chatModel: model,
    provider: endpoint.provider,
    sideModel: wireSideModel(endpoint.provider, model),
  });
};

/**
 * The thread `threadId` opened in a page of an organization whose chat model
 * is `endpoint`'s, as a user who picks that model sees it.
 */
const openSession = async ({
  caching,
  chatModel,
  endpoint,
  member = firstMember,
  threadId,
  tools,
}: {
  caching: CachingSetting;
  /** A chat model of the endpoint's provider its slots do not name. */
  chatModel?: string | undefined;
  endpoint: ModelEndpoint;
  /** Who opens the thread; the organization's first member by default. */
  member?: Member | undefined;
  threadId: SafeId<"chatThread">;
  tools: ToolSurface;
}) => {
  const { provider } = endpoint;
  const model = chatModel ?? modelOf(cassettes, endpoint);
  const seam = replayedHarnessModel({
    prompts: createPromptPrefixLedger(),
    provider,
    replay,
  });
  const harness = createApprovalHarness({
    ids,
    model: seam,
    organizationAIConfig: orgConfigOf(endpoint, chatModel),
    promptCachingEnabled: caching === "on",
    safeDb: member.safeDb,
    scopedDb: member.scopedDb,
    user: { context: member.context, id: member.id },
    sources:
      tools === "extended"
        ? {
            contextMatterIds: [member.matterId ?? ids.wsA1],
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

const parsedBody = (request: ReplayedRequest): Record<string, unknown> => {
  const body: unknown = JSON.parse(request.body);
  return isRecord(body) ? body : panic("A provider request body is an object");
};

/** The requests the chat model answered, rather than side calls. */
const chatRequestsOf = (sent: readonly ReplayedRequest[]) =>
  sent.filter(({ exchange }) => typeof exchange === "number");

/** One conversation's turns take a few seconds; retried failures wait out
 *  each SDK's backoff. */
const CONVERSATION_TIMEOUT_MS = 60_000;

// --- The cached prefix ----------------------------------------------------------
//
// What the chat request builder (`chat-request.ts`) promises each provider's
// prompt cache, held on the bodies the SDKs wrote:
// - every adapter states how its provider caches (`PROVIDER_PROMPT_CACHING`),
//   and one that caches nothing carries a written waiver;
// - where the provider caches at markers, the system prompt's static and
//   organization layers each end in one and the per-user tail carries none,
//   the request-level marker rides on every request, and the marked prefix is
//   byte-identical across a thread's turns and tool-loop iterations, each
//   request extending the one before it; any other provider is sent no marker;
// - two members of one organization send the same tools and the same system
//   prompt through its organization layer, whatever their own profile says;
// - each surface's stable prefix (tools, static and organization layers) is
//   held to a committed ratchet, and each tool to a size budget whose
//   exceptions are written down (`chat-prompt-baseline.json`).

/** OpenRouter's matrix endpoints serve OpenAI models, which it caches
 *  implicitly; this one is an Anthropic model it caches at markers. */
const OPENROUTER_MARKER_MODEL = "anthropic/claude-sonnet-5.5";

type CacheEndpoint = {
  chatModel?: string | undefined;
  key: string;
  provider: TanStackAIProvider;
};

const CACHE_ENDPOINTS: readonly CacheEndpoint[] = [
  ...TANSTACK_AI_PROVIDERS.map((provider) => ({ key: provider, provider })),
  {
    chatModel: OPENROUTER_MARKER_MODEL,
    key: "openrouter-anthropic",
    provider: "openrouter",
  },
];

const cacheEndpointModel = ({ chatModel, provider }: CacheEndpoint): string =>
  chatModel ?? modelOf(cassettes, { provider, slot: "recorded" });

/** The organization's own setting, which opens its prompt layer. */
const PRACTICE_JURISDICTIONS = [
  { countryCode: "CZ", isPrimary: true },
] as const satisfies readonly PracticeJurisdiction[];
const PRACTICE_JURISDICTION_LINE = "User generally practices law in: Czechia.";

/** Two members' profiles, which differ in every field a profile shows. */
const MEMBER_CONTEXTS = [
  { locale: "en", timezone: "Europe/Prague", userName: "First Member" },
  { locale: "cs", timezone: "Europe/Prague", userName: "Second Member" },
] as const satisfies readonly IncomingUserContext[];

/** The static and organization layers' text; panics when the prompt does
 *  not carry the organization's line. */
const cacheableSystemTextOf = (system: string): string => {
  const at = system.indexOf(PRACTICE_JURISDICTION_LINE);
  if (at === -1) {
    return panic("The system prompt carries the organization's layer");
  }
  return system.slice(0, at + PRACTICE_JURISDICTION_LINE.length);
};

/** A fresh thread's first turn, as `member` sends it with caching on. */
const firstTurnBody = async ({
  endpoint,
  member,
  tools,
}: {
  endpoint: CacheEndpoint;
  member: Member;
  tools: ToolSurface;
}): Promise<Record<string, unknown>> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  replay.forgetSignedCalls();
  const session = await openSession({
    caching: "on",
    chatModel: endpoint.chatModel,
    endpoint: { provider: endpoint.provider, slot: "recorded" },
    member,
    threadId,
    tools,
  });
  try {
    replay.serve(session.answer);
    await session.client.sendUserMessage(Bun.randomUUIDv7(), "Thanks");
    await session.harness.expectSoundWebClient({
      client: session.client,
      threadId,
    });
    const [request] = chatRequestsOf(session.seam.sentRequests());
    return request === undefined
      ? panic("The turn reached the chat endpoint")
      : parsedBody(request);
  } finally {
    await session.close();
  }
};

/**
 * One thread with caching on: a turn answered with a tool call, its
 * continuation once the page approves it (the tool loop's next iteration),
 * and a later turn. The chat requests, in order.
 */
const cachedThreadBodies = async (
  endpoint: CacheEndpoint,
): Promise<Record<string, unknown>[]> => {
  const { provider } = endpoint;
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  replay.forgetSignedCalls();
  const session = await openSession({
    caching: "on",
    chatModel: endpoint.chatModel,
    endpoint: { provider, slot: "recorded" },
    threadId,
    tools: "default",
  });
  try {
    replay.serve(
      cassetteForModel(
        toolCallAnswerFor({
          cassette: cassetteFor(cassettes, provider, "tool-call"),
          history: "plain",
          provider,
        }),
        session.model,
      ),
    );
    await session.client.sendUserMessage(
      Bun.randomUUIDv7(),
      "Delete the draft",
    );
    await session.harness.expectSoundWebClient({
      client: session.client,
      threadId,
    });
    const call = pendingApprovalCallOf(
      (await session.harness.lastAssistant(threadId)).parts,
    );
    replay.enqueue(session.answer);
    await session.client.approve(call.id, true);
    await session.harness.expectSoundWebClient({
      client: session.client,
      threadId,
    });
    replay.serve(session.answer);
    await session.client.sendUserMessage(Bun.randomUUIDv7(), "Thanks");
    await session.harness.expectSoundWebClient({
      client: session.client,
      threadId,
    });
    return chatRequestsOf(session.seam.sentRequests()).map(parsedBody);
  } finally {
    await session.close();
  }
};

/** The prefix a marker-caching provider reads: the tools, then every system
 *  block up to the last marked one. */
const markedPrefixOf = (
  provider: TanStackAIProvider,
  body: Record<string, unknown>,
): string => {
  const blocks = systemBlocksOf(provider, body);
  const lastMarked = blocks.findLastIndex(({ marked }) => marked);
  return JSON.stringify({
    system: blocks.slice(0, lastMarked + 1).map(({ text }) => text),
    tools: toolsSectionOf(provider, body),
  });
};

/** The provider-visible messages of a request, one JSON text each, without
 *  cache markers (a marker says where a cached prefix ends, not what it
 *  holds). */
const messageTextsOf = (
  provider: TanStackAIProvider,
  body: Record<string, unknown>,
): string[] =>
  WIRE_PROMPT_SECTIONS[provider](body).messages.map((message) =>
    JSON.stringify(message, (key, value: unknown) =>
      key === "cache_control" || key === "cacheControl" ? undefined : value,
    ),
  );

/** The stable-prefix size each surface measured, for the ratchet test. */
const measuredStablePrefixes = new Map<string, number>();
const BILLING_BUDGET_FEATURE_ID = "time-billing";

/** Two members of the organization send `endpoint` the same tools and system
 *  prompt through its organization layer, marked where the provider caches at
 *  markers; records the surface's stable-prefix size. */
const expectMembersShareThePrefix = async (
  endpoint: CacheEndpoint,
  tools: ToolSurface,
) => {
  const { provider } = endpoint;
  // A matter both members reach, for the extended surface.
  const a = await firstTurnBody({
    endpoint,
    member: {
      ...firstMember,
      context: MEMBER_CONTEXTS[0],
      matterId: ids.wsA2,
    },
    tools,
  });
  const b = await firstTurnBody({
    endpoint,
    member: {
      ...secondMember,
      context: MEMBER_CONTEXTS[1],
      matterId: ids.wsA2,
    },
    tools,
  });
  const systemA = systemTextOf(provider, a);
  const systemB = systemTextOf(provider, b);
  // Each member's own layer reaches the prompt, so the prompts
  // differ.
  expect(systemA).toContain(MEMBER_CONTEXTS[0].userName);
  expect(systemB).toContain(MEMBER_CONTEXTS[1].userName);
  const cacheable = cacheableSystemTextOf(systemA);
  // Everything through the organization's layer is the same bytes.
  expect(JSON.stringify(toolsSectionOf(provider, b))).toBe(
    JSON.stringify(toolsSectionOf(provider, a)),
  );
  expect(commonPrefixLength(systemA, systemB)).toBeGreaterThanOrEqual(
    cacheable.length,
  );
  if (
    promptCachingUsesBreakpoints({
      modelId: cacheEndpointModel(endpoint),
      provider,
    })
  ) {
    // The markers close exactly the shared layers.
    expect(markedPrefixOf(provider, b)).toBe(markedPrefixOf(provider, a));
    expect(
      systemBlocksOf(provider, a)
        .filter(({ marked }) => marked)
        .map(({ text }) => text)
        .join(""),
    ).toBe(cacheable);
  }
  measuredStablePrefixes.set(
    `${endpoint.key}/${tools}`,
    estimatedWireTokens(toolsSectionOf(provider, a)) +
      estimatedTokens({ prose: cacheable }),
  );
};

describe("chat requests: the cached prefix", () => {
  let previousJurisdictions: PracticeJurisdiction[] = [];

  beforeAll(async () => {
    const [row] = await testDb
      .select({
        practiceJurisdictions: organizationSettings.practiceJurisdictions,
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, ids.orgA));
    previousJurisdictions = row?.practiceJurisdictions ?? [];
    await testDb
      .update(organizationSettings)
      .set({ practiceJurisdictions: [...PRACTICE_JURISDICTIONS] })
      .where(eq(organizationSettings.organizationId, ids.orgA));
  });

  afterAll(async () => {
    await testDb
      .update(organizationSettings)
      .set({ practiceJurisdictions: previousJurisdictions })
      .where(eq(organizationSettings.organizationId, ids.orgA));
  });

  test("every adapter states how its provider caches, and one that caches nothing says why", () => {
    const caching: Readonly<Record<TanStackAIProvider, ProviderPromptCaching>> =
      PROVIDER_PROMPT_CACHING;
    expect(Object.keys(caching).toSorted()).toEqual(
      [...TANSTACK_AI_PROVIDERS].toSorted(),
    );
    expect(
      TANSTACK_AI_PROVIDERS.filter((provider) => {
        const entry = caching[provider];
        const text = entry.mechanism === "none" ? entry.waiver : entry.source;
        return text.trim().length === 0;
      }),
    ).toEqual([]);
  });

  for (const endpoint of CACHE_ENDPOINTS) {
    test(
      `${endpoint.key}: history and every tool-loop iteration reuse the cached prefix`,
      async () => {
        const { provider } = endpoint;
        const bodies = await cachedThreadBodies(endpoint);
        // The turn, its continuation after the tool result, the later turn.
        expect(bodies).toHaveLength(3);
        const markers = promptCachingUsesBreakpoints({
          modelId: cacheEndpointModel(endpoint),
          provider,
        });
        if (!markers) {
          expect(bodies.flatMap((body) => cacheMarkersOf(body))).toEqual([]);
          return;
        }
        for (const body of bodies) {
          // A marker after the static layer and one after the
          // organization's, none on the per-user tail, and the
          // request-level marker: three of the four a request may carry.
          expect(
            systemBlocksOf(provider, body).map(({ marked }) => marked),
          ).toEqual([true, true, false]);
          expect(cacheMarkersOf(body)).toContain("body.cache_control");
          expect(cacheMarkersOf(body)).toHaveLength(3);
        }
        // Every request reads the same marked prefix.
        expect(
          new Set(bodies.map((body) => markedPrefixOf(provider, body))).size,
        ).toBe(1);
        // Each request begins with every message of the one before it, so
        // the request-level marker the earlier one wrote is read.
        for (const [index, body] of bodies.entries()) {
          const previous = bodies[index - 1];
          if (previous === undefined) {
            continue;
          }
          const earlier = messageTextsOf(provider, previous);
          expect(
            messageTextsOf(provider, body).slice(0, earlier.length),
          ).toEqual(earlier);
        }
      },
      propertyTestTimeout(CONVERSATION_TIMEOUT_MS),
    );

    for (const tools of TOOL_SURFACES) {
      test(
        `${endpoint.key}, ${tools} tools: two members of one organization share the prefix through its layer`,
        async () => {
          await expectMembersShareThePrefix(endpoint, tools);
        },
        propertyTestTimeout(CONVERSATION_TIMEOUT_MS),
      );
    }
  }

  test("each surface's stable prefix holds to its committed ratchet", () => {
    expect(measuredStablePrefixes.size).toBe(
      CACHE_ENDPOINTS.length * TOOL_SURFACES.length,
    );
    const reason = chatPromptBaselineUpdateReason();
    if (reason !== null) {
      writeStablePrefixTokens({ measured: measuredStablePrefixes, reason });
      return;
    }
    const baseline = readChatPromptBaseline();
    expect([
      ...[...measuredStablePrefixes].flatMap(([key, measured]) =>
        findStablePrefixDrift({ baseline, key, measured }),
      ),
      ...Object.keys(baseline.stablePrefixTokens)
        .filter((key) => !measuredStablePrefixes.has(key))
        .map((key) => `${key}: committed but no longer measured`),
    ]).toEqual([]);
  });

  test(
    "every tool fits its size budget or says why it does not",
    async () => {
      const identity =
        (
          await testDb
            .select({ emailVerified: authUser.emailVerified })
            .from(authUser)
            .where(eq(authUser.id, firstMember.id))
            .limit(1)
        ).at(0) ?? panic("The budget caller exists");
      // The shared-prefix fixtures stay unenrolled; budget the billing tools
      // through a separate admitted request using the production policy.
      try {
        await enrolTimeBilling(testDb, [
          { organizationId: ids.orgA, userId: firstMember.id },
        ]);
        const body = await firstTurnBody({
          endpoint: { key: "anthropic", provider: "anthropic" },
          member: { ...firstMember, matterId: ids.wsA2 },
          tools: "extended",
        });
        const { toolTokenBudget, toolsOverBudget } = readChatPromptBaseline();
        const sizes = new Map(
          anthropicToolEntriesOf(body).map(({ name, wire }) => [
            name,
            estimatedWireTokens(wire),
          ]),
        );
        expect(sizes.size).toBeGreaterThan(0);
        expect([
          ...[...sizes]
            .filter(
              ([name, tokens]) =>
                tokens > toolTokenBudget && toolsOverBudget[name] === undefined,
            )
            .map(
              ([name, tokens]) =>
                `${name}: ${String(tokens)} estimated tokens, over the ${String(toolTokenBudget)} budget; trim it or add a written reason to toolsOverBudget`,
            ),
          ...Object.keys(toolsOverBudget)
            .filter((name) => (sizes.get(name) ?? 0) <= toolTokenBudget)
            .map(
              (name) =>
                `${name}: listed over budget but ${String(sizes.get(name) ?? 0)} estimated tokens fit it; remove the entry`,
            ),
        ]).toEqual([]);
      } finally {
        await testDb
          .delete(featureEnrolments)
          .where(
            and(
              eq(featureEnrolments.organizationId, ids.orgA),
              eq(featureEnrolments.userId, firstMember.id),
              eq(featureEnrolments.featureId, BILLING_BUDGET_FEATURE_ID),
            ),
          );
        await testDb
          .update(authUser)
          .set({ emailVerified: identity.emailVerified })
          .where(eq(authUser.id, firstMember.id));
      }
    },
    propertyTestTimeout(CONVERSATION_TIMEOUT_MS),
  );
});
