/**
 * The read budget of a decision whose analysis is already stored or in
 * flight.
 *
 * Readers poll this route while a run is in flight and reopen decisions
 * whose analysis is finished, so these two answers are its hot path: they
 * must cost the decision read and nothing else. No model action may be
 * admitted or started on either, and no claim may be written (a claim goes
 * through the shared pool, which a hermetic test points at the counting
 * sentinel). The statement count is the fixed plan: the scoped transaction's
 * settings and the one decision read, the same on every call.
 */

import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { PersistedDecisionAnalysis } from "@stll/legal-ast/analysis";
import type { DocumentAst, ParagraphBlock } from "@stll/legal-ast/document-ast";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createMembershipScopedDb } from "@/api/db/scoped";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import {
  ORG_AI_CONFIG_STATUS,
  type OrgAIConfigStatus,
} from "@/api/lib/ai-config-loader-core";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { analysisSentinel } from "@/api/lib/case-law/stored-analysis";
import {
  queryCountLogger,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { executeRowsScopedDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import {
  getTestDb,
  releaseTestDb,
  withQueryLogger,
} from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { rootPoolConnectionCount } from "@/api/tests/test-database-environment";

import { resolveAnalysisInput } from "./analysis-input";
import { buildDecisionAnalysis } from "./analysis-output";
import { generateAnalysis } from "./generate";

const ORGANIZATION_ID = toSafeId<"organization">("org_test");
const USER_ID = toSafeId<"user">("user_test");

/** The scoped transaction's settings statement, then the decision read. */
const STORED_ANSWER_STATEMENTS = 2;
const REPEATED_CALLS = 3;

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

// An organization key for the fast role: if either stored answer fell
// through to generation, nothing would stop it at a missing provider.
const availableAIConfig = {
  providers: [{ provider: "openai", apiKey: "test-api-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-5.4-mini" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
  },
  decision: null,
} satisfies OrgAIConfig;

describe("answering a stored or in-flight analysis", () => {
  let db: TestDatabase;
  let countedDb: TestDatabase;
  let featureAccessSnapshot: FeatureAccessSnapshot;
  let sourceId: SafeId<"caseLawSource">;
  let counter = 0;

  beforeAll(async () => {
    db = await getTestDb();
    countedDb = withQueryLogger(db, queryCountLogger);
    // Auth resolves feature facts before lending the request its database scope.
    featureAccessSnapshot = await db.transaction(
      async (tx) =>
        await resolveFeatureAccessSnapshot({
          tx,
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
        }),
    );
    const [source] = await db
      .insert(caseLawSources)
      .values({
        name: `analysis-budget-${Bun.randomUUIDv7().slice(0, 8)}`,
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

  const scopedDbOf = (database: TestDatabase) =>
    executeRowsScopedDb(
      createMembershipScopedDb(database, {
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        serverValidatedWorkspaceIds: [],
        featureAccessSnapshot,
      }),
    );

  /** A decision whose stored analysis is built over its own current input. */
  const insertDecision = async (
    analysisFor: (
      fingerprint: string,
      anchorIds: readonly string[],
    ) => PersistedDecisionAnalysis,
  ): Promise<{
    decisionId: SafeId<"caseLawDecision">;
    fingerprint: string;
  }> => {
    counter += 1;
    const [row] = await db
      .insert(caseLawDecisions)
      .values({
        sourceId,
        caseNumber: `21 Cdo ${String(counter)}/2026`,
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        documentAst,
      })
      .returning({ id: caseLawDecisions.id });
    if (!row) {
      throw new Error("expected a decision row");
    }
    const resolution = (
      await resolveAnalysisInput({
        decisionId: row.id,
        scopedDb: scopedDbOf(db),
      })
    ).unwrap();
    if (resolution.kind !== "resolved") {
      return panic(`expected a resolvable decision, got ${resolution.kind}`);
    }
    await db
      .update(caseLawDecisions)
      .set({
        analysis: analysisFor(
          resolution.input.fingerprint,
          resolution.anchorIds,
        ),
      })
      .where(eq(caseLawDecisions.id, row.id));

    // Saving the analysis changes updatedAt, hence the row-cache identity.
    // These repeated-read budgets start with that persisted version warm.
    const warmed = (
      await resolveAnalysisInput({
        decisionId: row.id,
        scopedDb: scopedDbOf(db),
      })
    ).unwrap();
    if (warmed.kind !== "resolved") {
      return panic(`expected a warm decision, got ${warmed.kind}`);
    }
    expect(warmed.input.fingerprint).toBe(resolution.input.fingerprint);
    return { decisionId: row.id, fingerprint: resolution.input.fingerprint };
  };

  const answer = async ({
    decisionId,
    orgAIConfig,
    orgAIConfigStatus,
  }: {
    decisionId: SafeId<"caseLawDecision">;
    orgAIConfig: OrgAIConfig | null;
    orgAIConfigStatus: OrgAIConfigStatus;
  }) => {
    const modelActions: string[] = [];
    const claimsBefore = rootPoolConnectionCount();
    expect(claimsBefore).not.toBeNull();
    const { response, statements } = await runWithQueryCounter(
      async (queries) => {
        const result = await generateAnalysis({
          admitModelAction: async () => {
            modelActions.push("admit");
            return panic("A stored answer must not admit a model action");
          },
          startModelAction: async () => {
            modelActions.push("start");
            return panic("A stored answer must not start a model action");
          },
          decisionId,
          scopedDb: scopedDbOf(countedDb),
          organizationId: ORGANIZATION_ID,
          orgAIConfig,
          orgAIConfigStatus,
          promptCachingEnabled: false,
          retry: false,
        });
        return { response: result, statements: queries.count };
      },
    );
    expect(modelActions).toEqual([]);
    expect(rootPoolConnectionCount()).toBe(claimsBefore);
    return { response: response.unwrap(), statements };
  };

  test("a run in flight answers generating from the decision read alone", async () => {
    const { decisionId } = await insertDecision((fingerprint) =>
      analysisSentinel(fingerprint, new Date()),
    );

    const answers = [];
    for (const _call of Array.from({ length: REPEATED_CALLS })) {
      answers.push(
        await answer({
          decisionId,
          orgAIConfig: availableAIConfig,
          orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
        }),
      );
    }

    expect(answers).toEqual(
      Array.from({ length: REPEATED_CALLS }, () => ({
        response: { status: "generating" },
        statements: STORED_ANSWER_STATEMENTS,
      })),
    );
  });

  // The organization's AI configuration is unreadable, so the background
  // significance refresh stops before its graph read: what is counted is the
  // answer's own plan. A finished analysis must stay readable then, too.
  test("a finished analysis answers done from the decision read alone", async () => {
    const { decisionId, fingerprint } = await insertDecision(
      (inputFingerprint, anchorIds) =>
        buildDecisionAnalysis({
          anchorIds,
          generatedAt: new Date("2026-09-01T12:00:00.000Z"),
          inputFingerprint,
          language: "cs",
          model: "some-provider/some-model",
          output: {
            headings: [
              {
                id: "",
                label: "Odůvodnění",
                category: "reasoning",
                startAnchorId: "b2",
                endAnchorId: "b2",
                annotations: [],
              },
            ],
            holding: [
              {
                text: "Dovolání není přípustné.",
                anchors: [{ startAnchorId: "b2", endAnchorId: "b2" }],
              },
            ],
            abstract: [{ text: "Soud dovolání zamítl.", anchors: [] }],
            topics: ["dovolání"],
          },
        }),
    );

    const answers = [];
    for (const _call of Array.from({ length: REPEATED_CALLS })) {
      answers.push(
        await answer({
          decisionId,
          orgAIConfig: null,
          orgAIConfigStatus: ORG_AI_CONFIG_STATUS.unreadable,
        }),
      );
    }

    for (const { response, statements } of answers) {
      expect(response).toMatchObject({
        status: "done",
        analysis: { inputFingerprint: fingerprint },
      });
      expect(statements).toBe(STORED_ANSWER_STATEMENTS);
    }
  });

  test("repeated version changes return a bounded analysis-input failure", async () => {
    const [row] = await db
      .insert(caseLawDecisions)
      .values({
        sourceId,
        caseNumber: "changing input",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        documentAst,
        contentHash: "0".repeat(64),
      })
      .returning({ id: caseLawDecisions.id });
    if (!row) {
      panic("Expected a decision row");
    }
    const baseScopedDb = scopedDbOf(db);
    let reads = 0;
    const racingScopedDb: ScopedDb = async (read) => {
      reads += 1;
      if (reads % 2 === 0) {
        await db
          .update(caseLawDecisions)
          .set({ contentHash: String(reads).padStart(64, "0") })
          .where(eq(caseLawDecisions.id, row.id));
      }
      return await baseScopedDb(read);
    };

    const resolution = await resolveAnalysisInput({
      decisionId: row.id,
      scopedDb: racingScopedDb,
    });
    expect(Result.isError(resolution)).toBe(true);
    if (Result.isOk(resolution)) {
      panic("Changing input must report its retry exhaustion");
    }
    expect(resolution.error).toMatchObject({
      _tag: "AnalysisInputVersionChangedError",
      decisionId: row.id,
      attempts: 3,
    });
    expect(reads).toBe(resolution.error.attempts * 2);

    const generated = await generateAnalysis({
      admitModelAction: async () =>
        panic("Changing input cannot admit a model action"),
      startModelAction: async () =>
        panic("Changing input cannot start a model action"),
      decisionId: row.id,
      scopedDb: racingScopedDb,
      organizationId: ORGANIZATION_ID,
      orgAIConfig: availableAIConfig,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      promptCachingEnabled: false,
      retry: false,
    });
    expect(Result.isError(generated)).toBe(true);
    if (Result.isOk(generated)) {
      panic("Changing input must reach the caller as a failure");
    }
    expect(generated.error).toMatchObject({
      status: 409,
      cause: { _tag: "AnalysisInputVersionChangedError", decisionId: row.id },
    });
    expect(reads).toBe(resolution.error.attempts * 4);
  });

  test("an AST read retries with fresh metadata when ingestion replaces the row version", async () => {
    const oldUpdatedAt = new Date("2026-10-01T00:00:00.000Z");
    const newUpdatedAt = new Date("2026-10-02T00:00:00.000Z");
    const oldContentHash = "a".repeat(64);
    const newContentHash = "b".repeat(64);
    const newDocumentAst = {
      ...documentAst,
      blocks: [paragraph("new-version", "Nové znění rozhodnutí")],
    } satisfies DocumentAst;
    const [row] = await db
      .insert(caseLawDecisions)
      .values({
        sourceId,
        caseNumber: "old metadata",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        documentAst,
        contentHash: oldContentHash,
        updatedAt: oldUpdatedAt,
      })
      .returning({ id: caseLawDecisions.id });
    if (!row) {
      throw new Error("expected a decision row");
    }

    const baseScopedDb = scopedDbOf(db);
    let reads = 0;
    const racingScopedDb: ScopedDb = async (read) => {
      reads += 1;
      if (reads === 2) {
        await db
          .update(caseLawDecisions)
          .set({
            caseNumber: "new metadata",
            documentAst: newDocumentAst,
            contentHash: newContentHash,
            updatedAt: newUpdatedAt,
          })
          .where(eq(caseLawDecisions.id, row.id));
      }
      return await baseScopedDb(read);
    };

    const resolution = (
      await resolveAnalysisInput({
        decisionId: row.id,
        scopedDb: racingScopedDb,
      })
    ).unwrap();
    if (resolution.kind !== "resolved") {
      panic(`expected a resolved decision, got ${resolution.kind}`);
    }
    expect(reads).toBe(4);
    expect(resolution.decision).toMatchObject({
      caseNumber: "new metadata",
      contentHash: newContentHash,
      updatedAt: newUpdatedAt,
    });
    expect(resolution.anchorIds).toEqual(["new-version"]);

    // Keep the identity fixed while poisoning storage: the second resolution
    // must use the AST cached under the new identity, not read this value.
    await db
      .update(caseLawDecisions)
      .set({
        documentAst,
        contentHash: newContentHash,
        updatedAt: newUpdatedAt,
      })
      .where(eq(caseLawDecisions.id, row.id));
    const cached = (
      await resolveAnalysisInput({
        decisionId: row.id,
        scopedDb: baseScopedDb,
      })
    ).unwrap();
    if (cached.kind !== "resolved") {
      panic(`expected a cached decision, got ${cached.kind}`);
    }
    expect(cached.decision).toMatchObject({
      caseNumber: "new metadata",
      contentHash: newContentHash,
      updatedAt: newUpdatedAt,
    });
    expect(cached.anchorIds).toEqual(["new-version"]);
  });
});
