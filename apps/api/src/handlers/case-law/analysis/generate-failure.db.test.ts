/**
 * A generation run that fails releases the decision row and files a record of
 * why under its reader's key, and the read answers that record: so a reader
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
import { eq, sql } from "drizzle-orm";

import {
  BYOK_DEFAULT_MODELS,
  getOutputTokenLimit,
  TANSTACK_AI_PROVIDERS,
} from "@stll/ai-catalog";
import type { AnalysisGenerating } from "@stll/legal-ast/analysis";
import type { DocumentAst, ParagraphBlock } from "@stll/legal-ast/document-ast";

import {
  caseLawAnalysisFailures,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  ANALYSIS_FAILURE_HOLD_MS,
  analysisFailureKeyTag,
  failureClaimGuard,
  analysisFailureRecord,
} from "@/api/lib/case-law/analysis-failure";
import { createDbAnalysisStore } from "@/api/lib/case-law/analysis-store-core";
import { analysisSentinel } from "@/api/lib/case-law/stored-analysis";
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
const ORG_B = toSafeId<"organization">("org_analysis_b");
const FINGERPRINT = "f".repeat(64);
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

/** The same organization after it moved its fast role to another provider. */
const anthropicKey = {
  providers: [
    { provider: "google", apiKey: "test-api-key" },
    { provider: "anthropic", apiKey: "test-api-key" },
  ],
  overrideModels: {
    ...googleKey.overrideModels,
    fast: { provider: "anthropic", modelId: "claude-haiku-4-5-20251001" },
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

  const holdRow = async (
    decisionId: SafeId<"caseLawDecision">,
    sentinel: AnalysisGenerating,
  ) => {
    await db
      .update(caseLawDecisions)
      .set({ analysis: sentinel })
      .where(eq(caseLawDecisions.id, decisionId));
  };

  const failureRows = async (decisionId: SafeId<"caseLawDecision">) =>
    await db
      .select({
        code: caseLawAnalysisFailures.code,
        keySource: caseLawAnalysisFailures.keySource,
        provider: caseLawAnalysisFailures.provider,
      })
      .from(caseLawAnalysisFailures)
      .where(eq(caseLawAnalysisFailures.decisionId, decisionId));

  const read = async ({
    decisionId,
    model,
    organizationId = ORG_A,
    orgAIConfig = googleKey,
    retry = false,
    deadlineMs,
    beforeClaim,
  }: {
    decisionId: SafeId<"caseLawDecision">;
    model: ResolvedTanStackTextModel | Promise<ResolvedTanStackTextModel>;
    organizationId?: SafeId<"organization">;
    orgAIConfig?: OrgAIConfig | null;
    retry?: boolean;
    deadlineMs?: number;
    beforeClaim?: () => Promise<void>;
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
      resolveTextModel: async () => await model,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      ...(beforeClaim === undefined ? {} : { beforeClaim }),
    });
    return { response: response.unwrap(), starts: starts.count };
  };

  test("an answer cut off on the organization's own key is recorded, told, and not run again by polling", async () => {
    const decisionId = await insertDecision();
    const google = fakeGoogle(["cut-off"]);

    const first = await read({ decisionId, model: google.model });
    expect(first).toEqual({ response: { status: "generating" }, starts: 1 });

    // The run released the shared row and filed how it failed on its own.
    expect(await storedValue(decisionId)).toBeNull();
    expect(await failureRows(decisionId)).toEqual([
      expect.objectContaining({
        code: "answer_incomplete",
        keySource: "organization",
        provider: "google",
      }),
    ]);

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

  test("two readers whose runs both fail, polling in turn, each keep their own failure and neither runs again unasked", async () => {
    const decisionId = await insertDecision();
    const first = fakeGoogle(["cut-off"]);
    const second = fakeGoogle(["cut-off"]);
    const asFirst = { decisionId, model: first.model };
    const asSecond = {
      decisionId,
      model: second.model,
      organizationId: ORG_B,
    };

    expect((await read(asFirst)).starts).toBe(1);
    // The first reader's failure is filed apart from the shared row, so the
    // second reader runs with its own key.
    expect((await read(asSecond)).starts).toBe(1);

    for (let round = 0; round < 3; round += 1) {
      for (const reader of [asFirst, asSecond]) {
        const poll = await read(reader);
        expect(poll).toEqual({
          response: expect.objectContaining({
            status: "error",
            code: "answer_incomplete",
          }),
          starts: 0,
        });
      }
    }
    expect(first.remaining()).toBe(0);
    expect(second.remaining()).toBe(0);
    expect(await failureRows(decisionId)).toHaveLength(2);
  });

  test("a read that found no failure does not run once a failure is filed before its claim", async () => {
    const decisionId = await insertDecision();
    const paused = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    const late = fakeGoogle([]);

    // The plain read finds neither an analysis nor a failure, then pauses
    // between that read and its claim.
    const lateRead = read({
      decisionId,
      model: late.model,
      beforeClaim: async () => {
        paused.resolve(undefined);
        await resume.promise;
      },
    });
    await paused.promise;

    // Meanwhile another request of the same reader claims, runs and fails.
    const other = fakeGoogle(["cut-off"]);
    expect((await read({ decisionId, model: other.model })).starts).toBe(1);
    expect(other.remaining()).toBe(0);

    resume.resolve(undefined);
    const answered = await lateRead;

    // Its claim refused, it answers the filed failure and asked no provider.
    expect(answered.response).toMatchObject({
      status: "error",
      code: "answer_incomplete",
    });
    expect(late.requests).toHaveLength(0);
    expect(await storedValue(decisionId)).toBeNull();
  });

  test("a plain claim reads failures only after it holds the row lock", async () => {
    const decisionId = await insertDecision();
    const now = new Date();
    const reader = { source: "platform" } as const;
    // A failure filed inside the claim's transaction, after its row lock and
    // before its failure read: where a failure write that held the lock would
    // have committed.
    const store = createDbAnalysisStore(db, {
      afterClaimLock: async (tx) => {
        await tx.execute(sql`
          INSERT INTO "case_law_analysis_failures"
            ("decision_id", "key_tag", "input_fingerprint", "code", "key_source", "provider", "recorded_at")
          VALUES (${decisionId}::uuid, 'platform', ${FINGERPRINT}, 'timed_out', 'platform', NULL, ${now.toISOString()}::timestamptz)
        `);
      },
    });

    const claimed = await store.claimUnlessFailed({
      decisionId,
      fingerprint: FINGERPRINT,
      observed: null,
      unlessFailed: failureClaimGuard({ decisionId, now, reader }),
    });

    // The failure read saw it, so the swap was rolled back (with the seam's
    // own insert, which shared the claim's transaction).
    expect(claimed.unwrap()).toBeNull();
    expect(await storedValue(decisionId)).toBeNull();
  });

  test("a plain claim with no failure filed after its lock takes the row", async () => {
    const decisionId = await insertDecision();
    const now = new Date();
    const seen: string[] = [];
    const store = createDbAnalysisStore(db, {
      afterClaimLock: async () => {
        seen.push("locked");
        await Promise.resolve();
      },
    });

    const claimed = (
      await store.claimUnlessFailed({
        decisionId,
        fingerprint: FINGERPRINT,
        observed: null,
        unlessFailed: failureClaimGuard({
          decisionId,
          now,
          reader: { source: "platform" },
        }),
      })
    ).unwrap();

    expect(seen).toEqual(["locked"]);
    expect(claimed).toMatchObject({ status: "generating" });
    expect(await storedValue(decisionId)).toEqual(claimed);
  });

  test("a retry paused the same way still runs: only a plain read is held back", async () => {
    const decisionId = await insertDecision();
    await read({ decisionId, model: fakeGoogle(["cut-off"]).model });
    const google = fakeGoogle(["valid"]);

    const retried = await read({
      decisionId,
      model: google.model,
      retry: true,
      beforeClaim: async () => {
        await Promise.resolve();
      },
    });

    expect(retried.response).toEqual({ status: "generating" });
    expect(google.requests).toHaveLength(1);
  });

  test("a superseded run's failure never replaces the failure of the run that replaced it", async () => {
    const decisionId = await insertDecision();
    // A first failing run files the record the read derives the current
    // input fingerprint from.
    await read({ decisionId, model: fakeGoogle(["cut-off"]).model });
    const [first] = await db
      .select({ inputFingerprint: caseLawAnalysisFailures.inputFingerprint })
      .from(caseLawAnalysisFailures)
      .where(eq(caseLawAnalysisFailures.decisionId, decisionId));
    if (first === undefined) {
      throw new Error("expected a failure record");
    }
    const current = first.inputFingerprint;
    const store = createDbAnalysisStore(db);
    const keyTag = analysisFailureKeyTag(
      { source: "organization", organizationId: ORG_A, provider: "google" },
      decisionId,
    );
    const failureOf = (
      code: "failed" | "timed_out",
      fingerprint: string,
      now: Date,
    ) =>
      analysisFailureRecord({
        code,
        fingerprint,
        now,
        reader: {
          source: "organization",
          organizationId: ORG_A,
          provider: "google",
        },
      });

    // A run over an earlier parse, then the replacement over the current one
    // that took the row over.
    const now = new Date();
    const superseded = analysisSentinel("e".repeat(64), now);
    const replacement = analysisSentinel(current, now);
    await holdRow(decisionId, replacement);

    // The replacement fails first; the superseded run settles after it.
    await store.fail({
      decisionId,
      keyTag,
      sentinel: replacement,
      failure: failureOf("timed_out", current, now),
    });
    await store.fail({
      decisionId,
      keyTag,
      sentinel: superseded,
      failure: failureOf("failed", "e".repeat(64), now),
    });

    expect(await failureRows(decisionId)).toEqual([
      expect.objectContaining({ code: "timed_out" }),
    ]);
    const poll = await read({ decisionId, model: fakeGoogle([]).model });
    expect(poll.response).toMatchObject({ status: "error", code: "timed_out" });
    expect(poll.starts).toBe(0);
  });

  test("an organization that switched its provider after a failed run runs on the new one", async () => {
    const decisionId = await insertDecision();
    await read({ decisionId, model: fakeGoogle(["cut-off"]).model });

    const switched = await read({
      decisionId,
      model: fakeGoogle(["valid"]).model,
      orgAIConfig: anthropicKey,
    });

    expect(switched).toEqual({ response: { status: "generating" }, starts: 1 });
  });

  test("recording a failure sweeps records past their hold, and keeps fresh ones", async () => {
    const expiredDecision = await insertDecision();
    const freshDecision = await insertDecision();
    const now = new Date();
    const store = createDbAnalysisStore(db);
    // Each run holds its decision's row, as a claimed run does.
    const recordFor = async (
      decisionId: SafeId<"caseLawDecision">,
      recordedAt: Date,
    ) => {
      const sentinel = analysisSentinel(FINGERPRINT, recordedAt);
      await holdRow(decisionId, sentinel);
      await store.fail({
        decisionId,
        keyTag: "platform",
        sentinel,
        failure: analysisFailureRecord({
          code: "failed",
          fingerprint: FINGERPRINT,
          now: recordedAt,
          reader: { source: "platform" },
        }),
      });
    };

    await recordFor(
      expiredDecision,
      new Date(now.getTime() - ANALYSIS_FAILURE_HOLD_MS - 1000),
    );
    expect(await failureRows(expiredDecision)).toHaveLength(1);

    await recordFor(freshDecision, now);

    expect(await failureRows(expiredDecision)).toHaveLength(0);
    expect(await failureRows(freshDecision)).toHaveLength(1);
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
      /* oxlint-disable typescript/no-unsafe-type-assertion -- focused pure helper test */
      const model = {
        adapter: {},
        keySource: "byok",
        modelId,
        modelOptions: {},
        provider,
      } as ResolvedTanStackTextModel;
      /* oxlint-enable typescript/no-unsafe-type-assertion */
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
