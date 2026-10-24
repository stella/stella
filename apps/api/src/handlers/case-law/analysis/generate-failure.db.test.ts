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
import { AI_DISCLOSURES } from "@stll/api-contract/ai-disclosure";
import { PROVIDER_SETUP_ERROR_CODE } from "@stll/api-contract/provider-setup";
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
  analysisFailureRecord,
  failureClaimGuard,
} from "@/api/lib/case-law/analysis-failure";
import { createDbAnalysisStore } from "@/api/lib/case-law/analysis-store-core";
import { analysisSentinel } from "@/api/lib/case-law/stored-analysis";
import { createProviderCallError } from "@/api/lib/errors/provider-call-failure";
import { registerProviderDiagnosticCredentials } from "@/api/lib/errors/redacted-provider-diagnostic";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import type { DetachedModelActionStarter } from "@/api/lib/rate-limit/model-action-admission";
import { outputTokensWithinModelLimit } from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { PROVIDER_SETUP_ERROR_FIXTURES } from "@/api/tests/fixtures/provider-setup-errors";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
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
  holding: [{ text: "Dovolání se zamítá.", anchors: [] }],
  abstract: [{ text: "Soud dovolání zamítl.", anchors: [] }],
  topics: [],
};

/** How the faked provider answers one run. */
type ProviderAnswer =
  "cut-off" | "valid" | "never" | "refused" | "rate-limited";

/** The retry delay the rate-limited answer names: far past the wait cap. */
const RATE_LIMIT_DELAY_MS = 41_400_000;

const PROVIDER_RUN = { runId: "run-1", threadId: "thread-1" } as const;

const answerChunks = async function* (
  answer: Exclude<ProviderAnswer, "refused" | "rate-limited">,
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
      if (answer === "refused") {
        throw createProviderCallError({
          model,
          status: 403,
          evidence: {
            status: 403,
            error: {
              ...PROVIDER_SETUP_ERROR_FIXTURES[
                PROVIDER_SETUP_ERROR_CODE.googleApiNotEnabled
              ].error,
              message:
                "API not enabled for opaque-fixture-credential and sk-fixture-key",
            },
          },
        });
      }
      if (answer === "rate-limited") {
        // What Gemini answers a key whose daily quota is spent.
        throw createProviderCallError({
          model,
          status: 429,
          evidence: {
            status: 429,
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              message: "Quota exceeded for the day.",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.RetryInfo",
                  retryDelay: `${RATE_LIMIT_DELAY_MS / 1000}s`,
                },
              ],
            },
          },
        });
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
  registerProviderDiagnosticCredentials(model, ["opaque-fixture-credential"]);
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
      admission: testModelAdmission(organizationId, "case-law.analysis"),
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
    derivedAi = true,
  }: {
    decisionId: SafeId<"caseLawDecision">;
    model: ResolvedTanStackTextModel | Promise<ResolvedTanStackTextModel>;
    organizationId?: SafeId<"organization">;
    orgAIConfig?: OrgAIConfig | null;
    retry?: boolean;
    deadlineMs?: number;
    beforeClaim?: () => Promise<void>;
    derivedAi?: boolean;
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
      derivedAi,
      resolveTextModel: async () => await model,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      ...(beforeClaim === undefined ? {} : { beforeClaim }),
    });
    return { response: response.unwrap(), starts: starts.count };
  };

  for (const overrideModels of [
    null,
    { chat: googleKey.overrideModels.chat },
  ]) {
    test(`a ${overrideModels === null ? "default" : "partial"} model configuration attributes failures to the resolved fast provider`, async () => {
      const decisionId = await insertDecision();
      const orgAIConfig = { ...googleKey, overrideModels };

      await read({
        decisionId,
        model: fakeGoogle(["cut-off"]).model,
        orgAIConfig,
      });
      const poll = await read({
        decisionId,
        model: fakeGoogle([]).model,
        orgAIConfig,
      });
      expect(poll.response).toMatchObject({
        status: "error",
        code: "answer_incomplete",
        key: { source: "organization", provider: "google" },
      });
      expect(poll.starts).toBe(0);
    });
  }

  // A local, seeded or CI stack serves stored analyses and asks no model:
  // with derived AI off, opening a decision without one claims nothing,
  // starts nothing and files nothing, retry or not.
  test("with derived AI off, a decision without an analysis starts no run", async () => {
    const decisionId = await insertDecision();
    const google = fakeGoogle(["valid"]);

    for (const retry of [false, true]) {
      const { response, starts } = await read({
        decisionId,
        model: google.model,
        retry,
        derivedAi: false,
      });
      expect(response).toMatchObject({
        status: "error",
        code: "analysis_unavailable",
      });
      expect(starts).toBe(0);
    }
    // The provider was never asked: its one answer is still queued.
    expect(google.requests).toEqual([]);
    expect(google.remaining()).toBe(1);
    expect(await storedValue(decisionId)).toBeNull();
    expect(await failureRows(decisionId)).toEqual([]);
  });

  // A failure filed while derived AI was on must not offer a retry once the
  // deployment turns it off: off mode is the terminal answer, poll or retry.
  test("with derived AI off, a still-held failure answers unavailable, not retryable", async () => {
    const decisionId = await insertDecision();
    await read({ decisionId, model: fakeGoogle(["refused"]).model });
    const held = await read({ decisionId, model: fakeGoogle([]).model });
    expect(held.response).toMatchObject({ status: "error", code: "failed" });

    const google = fakeGoogle(["valid"]);
    for (const retry of [false, true]) {
      const { response, starts } = await read({
        decisionId,
        model: google.model,
        retry,
        derivedAi: false,
      });
      expect(response).toMatchObject({
        status: "error",
        code: "analysis_unavailable",
      });
      expect(starts).toBe(0);
    }
    expect(google.requests).toEqual([]);
    expect(await storedValue(decisionId)).toBeNull();
  });

  test("a provider refusal persists its redacted diagnostic until retry or a provider change", async () => {
    const decisionId = await insertDecision();
    const google = fakeGoogle(["refused", "valid"]);
    await read({ decisionId, model: google.model });
    const expectedDiagnostic = {
      provider: "google",
      code: PROVIDER_SETUP_ERROR_CODE.googleApiNotEnabled,
      message: "API not enabled for [redacted-secret] and [redacted-secret]",
    };
    const persisted = await db
      .select()
      .from(caseLawAnalysisFailures)
      .where(eq(caseLawAnalysisFailures.decisionId, decisionId));
    expect(persisted.at(0)?.providerDiagnostic).toEqual(expectedDiagnostic);
    expect(JSON.stringify(persisted)).not.toContain(
      "opaque-fixture-credential",
    );
    expect(JSON.stringify(persisted)).not.toContain("sk-fixture-key");

    for (let attempt = 0; attempt < 2; attempt++) {
      const held = await read({ decisionId, model: google.model });
      expect(held.starts).toBe(0);
      expect(held.response).toMatchObject({
        status: "error",
        code: "failed",
        key: { source: "organization", provider: "google" },
        providerDiagnostic: expectedDiagnostic,
      });
    }
    const retried = await read({
      decisionId,
      model: google.model,
      retry: true,
    });
    expect(retried.starts).toBe(1);
    expect(
      (await read({ decisionId, model: google.model })).response.status,
    ).toBe("done");

    const changedDecision = await insertDecision();
    await read({
      decisionId: changedDecision,
      model: fakeGoogle(["refused"]).model,
    });
    const switched = await read({
      decisionId: changedDecision,
      model: fakeGoogle(["valid"]).model,
      orgAIConfig: anthropicKey,
    });
    expect(switched.starts).toBe(1);
  });

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
      unlessFailed: failureClaimGuard({
        decisionId,
        now,
        reader,
        request: "poll",
      }),
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
          request: "poll",
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

  describe("a provider retry time past the wait cap", () => {
    const failureTimes = async (decisionId: SafeId<"caseLawDecision">) => {
      const [row] = await db
        .select({
          recordedAt: caseLawAnalysisFailures.recordedAt,
          retryAfter: caseLawAnalysisFailures.retryAfter,
        })
        .from(caseLawAnalysisFailures)
        .where(eq(caseLawAnalysisFailures.decisionId, decisionId));
      return row ?? panic("expected a failure record");
    };

    /** Moves the filed failure in time, as the clock moving on would. */
    const setFailureTimes = async (
      decisionId: SafeId<"caseLawDecision">,
      times: { recordedAt: Date; retryAfter: Date },
    ) => {
      await db
        .update(caseLawAnalysisFailures)
        .set(times)
        .where(eq(caseLawAnalysisFailures.decisionId, decisionId));
    };

    const pastHold = () =>
      new Date(Date.now() - ANALYSIS_FAILURE_HOLD_MS - 60_000);

    test("holds polls and explicit retries until then, and a poll past it and the hold runs again", async () => {
      const decisionId = await insertDecision();
      const google = fakeGoogle(["rate-limited", "valid"]);

      expect(await read({ decisionId, model: google.model })).toEqual({
        response: { status: "generating" },
        starts: 1,
      });
      const filed = await failureTimes(decisionId);
      expect(filed.retryAfter?.getTime()).toBe(
        filed.recordedAt.getTime() + RATE_LIMIT_DELAY_MS,
      );
      const retryAt = filed.retryAfter?.toISOString();

      // Neither a poll nor the reader's explicit retry reaches the provider:
      // both answer the failure and the time to retry after.
      for (const retry of [false, true]) {
        expect(await read({ decisionId, model: google.model, retry })).toEqual({
          response: expect.objectContaining({
            status: "error",
            code: "provider_refused",
            key: { source: "organization", provider: "google" },
            retryAt,
          }),
          starts: 0,
        });
      }

      // Past the plain hold, the retry time still holds both.
      await setFailureTimes(decisionId, {
        recordedAt: pastHold(),
        retryAfter: new Date(Date.now() + 60_000),
      });
      for (const retry of [false, true]) {
        const held = await read({ decisionId, model: google.model, retry });
        expect(held.response).toMatchObject({ status: "error" });
        expect(held.starts).toBe(0);
      }

      // A retry time that passed within the hold leaves the plain hold as
      // it always was: a poll answers the failure, with no time to wait for.
      await setFailureTimes(decisionId, {
        recordedAt: new Date(),
        retryAfter: new Date(Date.now() - 1000),
      });
      const withinHold = await read({ decisionId, model: google.model });
      expect(withinHold.starts).toBe(0);
      expect(withinHold.response).toMatchObject({ status: "error" });
      expect(withinHold.response).not.toHaveProperty("retryAt");

      // Past both, the next poll runs again.
      await setFailureTimes(decisionId, {
        recordedAt: pastHold(),
        retryAfter: new Date(Date.now() - 1000),
      });
      expect(await read({ decisionId, model: google.model })).toEqual({
        response: { status: "generating" },
        starts: 1,
      });
      expect(google.remaining()).toBe(0);
      expect(await storedValue(decisionId)).toMatchObject({ version: 4 });
    });

    test("refuses the claim itself, in its transaction, while the time is ahead", async () => {
      const cases = [
        { request: "retry", retryAfterIn: 60_000, claims: false },
        { request: "retry", retryAfterIn: -1000, claims: true },
        { request: "poll", retryAfterIn: 60_000, claims: false },
        { request: "poll", retryAfterIn: -1000, claims: true },
      ] as const;
      for (const { request, retryAfterIn, claims } of cases) {
        const decisionId = await insertDecision();
        const now = new Date();
        const retryAfter = new Date(now.getTime() + retryAfterIn);
        // Filed after the claim's read, past the plain hold: only the retry
        // time can refuse the claim.
        const store = createDbAnalysisStore(db, {
          afterClaimLock: async (tx) => {
            await tx.execute(sql`
              INSERT INTO "case_law_analysis_failures"
                ("decision_id", "key_tag", "input_fingerprint", "code", "key_source", "provider", "recorded_at", "retry_after")
              VALUES (${decisionId}::uuid, 'platform', ${FINGERPRINT}, 'provider_refused', 'platform', NULL,
                ${pastHold().toISOString()}::timestamptz, ${retryAfter.toISOString()}::timestamptz)
            `);
          },
        });

        const claimed = await store.claimUnlessFailed({
          decisionId,
          fingerprint: FINGERPRINT,
          observed: null,
          unlessFailed: failureClaimGuard({
            decisionId,
            now,
            reader: { source: "platform" },
            request,
          }),
        });

        expect({
          request,
          retryAfterIn,
          claimed: claimed.unwrap() !== null,
        }).toEqual({ request, retryAfterIn, claimed: claims });
      }
    });

    test("the expiry sweep keeps a record until its retry time passes", async () => {
      const waiting = await insertDecision();
      const lapsed = await insertDecision();
      const fresh = await insertDecision();
      const store = createDbAnalysisStore(db);
      const recordFor = async (
        decisionId: SafeId<"caseLawDecision">,
        recordedAt: Date,
        retryAfterMs?: number,
      ) => {
        const sentinel = analysisSentinel(FINGERPRINT, recordedAt);
        await holdRow(decisionId, sentinel);
        await store.fail({
          decisionId,
          keyTag: "platform",
          sentinel,
          failure: analysisFailureRecord({
            code: "provider_refused",
            fingerprint: FINGERPRINT,
            now: recordedAt,
            reader: { source: "platform" },
            retryAfterMs,
          }),
        });
      };

      const old = pastHold();
      // Both are past the plain hold; one's retry time is an hour ahead, the
      // other's passed a minute after it was filed.
      await recordFor(waiting, old, ANALYSIS_FAILURE_HOLD_MS + 60 * 60_000);
      await recordFor(lapsed, old, 60_000);
      await recordFor(fresh, new Date());

      expect(await failureRows(waiting)).toHaveLength(1);
      expect(await failureRows(lapsed)).toHaveLength(0);
      expect(await failureRows(fresh)).toHaveLength(1);
    });
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
    expect(await storedValue(decisionId)).toMatchObject({ version: 4 });
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
      analysis: {
        version: 4,
        holding: { spans: [{ text: "Dovolání se zamítá." }] },
      },
      // The finished analysis reaches the agent with what to tell the reader.
      aiDisclosure: { context: "caseLaw", text: AI_DISCLOSURES.caseLaw.text },
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
      const { modelId } = BYOK_DEFAULT_MODELS[provider].fast;
      const limit = getOutputTokenLimit(modelId);
      expect(limit).toBeGreaterThan(0);
      const model = {
        ...fakeGoogle([]).model,
        modelId,
        modelOptions: {},
        provider,
      };
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
