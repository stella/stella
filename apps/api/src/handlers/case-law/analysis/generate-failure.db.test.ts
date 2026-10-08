/**
 * A generation run that fails leaves a record of why on the decision row, in
 * place of its sentinel, and the read answers that record: so a reader
 * polling the run is told it ended (and with whose key), the poll never
 * starts the run that just failed a second time, and only an explicit retry
 * runs again.
 *
 * The row is real (the test database through the real row store); only the
 * provider is faked, at the adapter boundary the TanStack engine drives.
 */

import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  BYOK_DEFAULT_MODELS,
  getOutputTokenLimit,
  TANSTACK_AI_PROVIDERS,
} from "@stll/ai-catalog";
import type { DocumentAst, ParagraphBlock } from "@stll/legal-ast/document-ast";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createDbAnalysisStore } from "@/api/lib/case-law/analysis-store-core";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import type { DetachedModelActionStarter } from "@/api/lib/rate-limit/model-action-admission";
import { admitFixtureModelDispatch } from "@/api/lib/rate-limit/model-dispatch-admission";
import { outputTokensWithinModelLimit } from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { executeRowsScopedDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import {
  ANALYSIS_FAILURE_CODE_BY_KIND,
  ANALYSIS_GENERATION_DEADLINE_MS,
  ANALYSIS_OUTPUT_TOKEN_BUDGET,
  generateAnalysis,
} from "./generate";

const ORG_A = toSafeId<"organization">("org_analysis_a");
const USER_ID = toSafeId<"user">("user_analysis");

const paragraph = (anchorId: string, plainText: string): ParagraphBlock => ({
  id: anchorId,
  anchorId,
  type: "paragraph",
  plainText,
  inlines: [{ type: "text", text: plainText }],
});

const documentAst = {
  version: 1,
  source: { system: "test", documentId: "test", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: "21 Cdo 1/2026",
    ecli: null,
    court: "Nejvyšší soud",
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [paragraph("b1", "Rozsudek"), paragraph("b2", "Dovolání se zamítá.")],
} satisfies DocumentAst;

const googleKey = {
  providers: [{ provider: "google", apiKey: "test-api-key" }],
  overrideModels: {
    chat: { provider: "google", modelId: "gemini-3.8-flash" },
    fast: { provider: "google", modelId: "gemini-3.8-flash" },
    pdf: { provider: "google", modelId: "gemini-3.8-flash" },
    reasoning: { provider: "google", modelId: "gemini-3.8-flash" },
  },
  decision: null,
} satisfies OrgAIConfig;

const VALID_ANSWER = {
  headings: [],
  holding: { text: "Dovolání se zamítá.", anchors: [] },
  abstract: "Soud dovolání zamítl.",
  topics: [],
};

/** How the faked provider answers one run. */
type ProviderAnswer = "cut-off" | "valid" | "never";

const PROVIDER_RUN = { runId: "run-1", threadId: "thread-1" } as const;

const answerChunks = async function* (
  answer: ProviderAnswer,
  signal: AbortSignal | undefined,
): AsyncIterable<StreamChunk> {
  yield { type: EventType.RUN_STARTED, ...PROVIDER_RUN };
  switch (answer) {
    case "cut-off":
      // What Gemini's adapter reports for an answer cut off mid-JSON.
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: '{"headings": [{"label": "Skutko',
      };
      yield {
        type: EventType.RUN_ERROR,
        ...PROVIDER_RUN,
        code: "max_tokens",
        message: "The response was cut off.",
      };
      return;
    case "valid": {
      const raw = JSON.stringify(VALID_ANSWER);
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: raw,
      };
      yield {
        type: EventType.CUSTOM,
        name: "structured-output.complete",
        value: { object: VALID_ANSWER, raw },
      };
      yield {
        type: EventType.RUN_FINISHED,
        ...PROVIDER_RUN,
        finishReason: "stop",
      };
      return;
    }
    case "never": {
      if (signal === undefined) {
        throw new Error("The engine must hand the adapter the run's signal");
      }
      const aborted = Promise.withResolvers<undefined>();
      signal.addEventListener(
        "abort",
        () => {
          aborted.resolve(undefined);
        },
        { once: true },
      );
      await aborted.promise;
      return;
    }
    default:
      answer satisfies never;
      throw new TypeError("Unhandled provider answer");
  }
};

/** A Google model whose provider answers each run from `answers`, in turn. */
const fakeGoogle = (answers: ProviderAnswer[]) => {
  const requests: unknown[] = [];
  const adapter: AnyTextAdapter = {
    kind: "text",
    name: "fake-google",
    model: "gemini-3.8-flash",
    "~types": {
      providerOptions: {},
      inputModalities: ["text"],
      messageMetadataByModality: {},
      toolCapabilities: [],
      toolCallMetadata: {},
      systemPromptMetadata: undefined,
    },
    chatStream: () => panic("The analysis must not run as a chat"),
    structuredOutput: async () =>
      await Promise.reject(new Error("expected a streamed structured answer")),
    structuredOutputStream: (options) => {
      requests.push(options.chatOptions.modelOptions);
      const answer = answers.shift();
      if (answer === undefined) {
        return panic("An unexpected provider run");
      }
      return answerChunks(
        answer,
        options.chatOptions.request?.signal ?? undefined,
      );
    },
  };
  // SAFETY: `adapter` is a real `AnyTextAdapter` the engine drives; the rest
  // is the resolved model's bookkeeping.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- focused adapter fixture
  const model = {
    adapter,
    keySource: "byok",
    modelId: "gemini-3.8-flash",
    modelOptions: {},
    provider: "google",
  } as ResolvedTanStackTextModel;
  return { model, requests, remaining: () => answers.length };
};

/** Runs the claim and the background run inline, so a call settles both. */
const inlineStarter =
  (
    organizationId: SafeId<"organization">,
    starts: { count: number },
  ): DetachedModelActionStarter =>
  async ({ start, background }) => {
    starts.count += 1;
    const admitted = {
      signal: new AbortController().signal,
      admission: admitFixtureModelDispatch({
        organizationId,
        actionKind: "case-law.analysis",
      }),
    };
    const started = await start(admitted);
    await background(admitted, started);
    return Result.ok(started);
  };

describe("a failed analysis run", () => {
  let db: TestDatabase;
  let sourceId: SafeId<"caseLawSource">;

  beforeAll(async () => {
    db = await getTestDb();
    const [source] = await db
      .insert(caseLawSources)
      .values({
        name: `analysis-failure-${Bun.randomUUIDv7().slice(0, 8)}`,
        adapterKey: ADAPTER_KEYS.CZ_NS,
      })
      .returning({ id: caseLawSources.id });
    if (!source) {
      throw new Error("expected a case-law source row");
    }
    sourceId = source.id;
  });

  afterAll(async () => {
    await releaseTestDb();
  });

  const insertDecision = async (): Promise<SafeId<"caseLawDecision">> => {
    const [row] = await db
      .insert(caseLawDecisions)
      .values({
        sourceId,
        caseNumber: `21 Cdo ${Bun.randomUUIDv7()}/2026`,
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        documentAst,
      })
      .returning({ id: caseLawDecisions.id });
    if (!row) {
      throw new Error("expected a decision row");
    }
    return row.id;
  };

  const storedValue = async (decisionId: SafeId<"caseLawDecision">) => {
    const [row] = await db
      .select({ analysis: caseLawDecisions.analysis })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decisionId));
    return row?.analysis ?? null;
  };

  const read = async ({
    decisionId,
    model,
    organizationId = ORG_A,
    orgAIConfig = googleKey,
    retry = false,
    deadlineMs,
  }: {
    decisionId: SafeId<"caseLawDecision">;
    model: ResolvedTanStackTextModel | Promise<ResolvedTanStackTextModel>;
    organizationId?: SafeId<"organization">;
    orgAIConfig?: OrgAIConfig | null;
    retry?: boolean;
    deadlineMs?: number;
  }) => {
    const starts = { count: 0 };
    const response = await generateAnalysis({
      admitModelAction: async () =>
        panic("No significance refresh is expected here"),
      startModelAction: inlineStarter(organizationId, starts),
      decisionId,
      scopedDb: executeRowsScopedDb(
        createScopedDb(db, [], organizationId, USER_ID),
      ),
      organizationId,
      orgAIConfig,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      promptCachingEnabled: false,
      retry,
      store: createDbAnalysisStore(db),
      resolveTextModel: () => model,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    });
    return { response: response.unwrap(), starts: starts.count };
  };

  test("an answer cut off on the organization's own key is recorded, told, and not run again by polling", async () => {
    const decisionId = await insertDecision();
    const google = fakeGoogle(["cut-off"]);

    const first = await read({ decisionId, model: google.model });
    expect(first).toEqual({ response: { status: "generating" }, starts: 1 });

    // The run replaced its sentinel with the record of how it failed.
    const stored = await storedValue(decisionId);
    expect(stored).toMatchObject({
      status: "failed",
      code: "answer_incomplete",
      key: { source: "organization", provider: "google" },
    });

    // The next poll is told, with whose key, and starts nothing.
    const poll = await read({ decisionId, model: google.model });
    expect(poll).toEqual({
      response: {
        status: "error",
        code: "answer_incomplete",
        error:
          "The AI model returned an incomplete answer using your organization's google key",
        key: { source: "organization", provider: "google" },
      },
      starts: 0,
    });
    expect(google.remaining()).toBe(0);
  });

  test("the run asks for the analysis budget, bounded by the model's catalog limit", async () => {
    const decisionId = await insertDecision();
    const google = fakeGoogle(["valid"]);

    await read({ decisionId, model: google.model });

    expect(google.requests).toEqual([
      expect.objectContaining({
        maxOutputTokens: Math.min(
          ANALYSIS_OUTPUT_TOKEN_BUDGET,
          getOutputTokenLimit("gemini-3.8-flash") ?? 0,
        ),
      }),
    ]);
    expect(await storedValue(decisionId)).toMatchObject({ version: 3 });
  });

  test("a retry runs again and its answer is stored", async () => {
    const decisionId = await insertDecision();
    const google = fakeGoogle(["cut-off", "valid"]);
    await read({ decisionId, model: google.model });

    const retried = await read({
      decisionId,
      model: google.model,
      retry: true,
    });
    expect(retried).toEqual({ response: { status: "generating" }, starts: 1 });

    const done = await read({ decisionId, model: google.model });
    expect(done.starts).toBe(0);
    expect(done.response).toMatchObject({
      status: "done",
      analysis: { version: 3, holding: { text: "Dovolání se zamítá." } },
    });
  });

  test("a run whose model resolution never settles is recorded as timed out", async () => {
    const decisionId = await insertDecision();
    const pending = Promise.withResolvers<ResolvedTanStackTextModel>();

    const first = await read({
      decisionId,
      model: pending.promise,
      deadlineMs: 40,
    });
    expect(first).toEqual({ response: { status: "generating" }, starts: 1 });

    const poll = await read({ decisionId, model: fakeGoogle([]).model });
    expect(poll.response).toMatchObject({ status: "error", code: "timed_out" });
    expect(poll.starts).toBe(0);
  });

  test("a run that outlives its deadline is recorded as timed out", async () => {
    const decisionId = await insertDecision();
    const google = fakeGoogle(["never"]);

    await read({ decisionId, model: google.model, deadlineMs: 40 });

    const poll = await read({ decisionId, model: google.model });
    expect(poll.response).toMatchObject({
      status: "error",
      code: "timed_out",
      key: { source: "organization", provider: "google" },
    });
    expect(poll.starts).toBe(0);
  });
});

describe("the analysis run's bounds", () => {
  test("the deadline is far inside the sentinel's hold and the old two-minute bound", () => {
    expect(ANALYSIS_GENERATION_DEADLINE_MS).toBeLessThan(120_000 / 2);
    expect(ANALYSIS_GENERATION_DEADLINE_MS).toBeGreaterThan(0);
  });

  test("every provider's default fast model gets the analysis budget within its own limit", () => {
    for (const provider of TANSTACK_AI_PROVIDERS) {
      const modelId = BYOK_DEFAULT_MODELS[provider].fast;
      const limit = getOutputTokenLimit(modelId);
      expect(limit).toBeGreaterThan(0);
      // SAFETY: the helper reads only provider/modelOptions/modelId.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
      const model = {
        adapter: {},
        keySource: "byok",
        modelId,
        modelOptions: {},
        provider,
      } as ResolvedTanStackTextModel;
      expect(
        outputTokensWithinModelLimit(model, ANALYSIS_OUTPUT_TOKEN_BUDGET),
      ).toBe(Math.min(ANALYSIS_OUTPUT_TOKEN_BUDGET, limit ?? 0));
    }
  });

  test("every model failure kind tells the reader a decided reason", () => {
    // Total by type; this pins that none silently reads as a generic failure
    // except the one kind that names nothing.
    for (const [kind, code] of Object.entries(ANALYSIS_FAILURE_CODE_BY_KIND)) {
      expect(code === "failed").toBe(kind === "unknown");
    }
  });
});
