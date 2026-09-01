/**
 * Generate AI analysis for a court decision.
 *
 * Returns the stored analysis when it was computed over the document as
 * it reads today. Otherwise kicks off background generation and returns
 * 202. The frontend polls until the analysis is ready.
 */

import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";
import * as v from "valibot";

import type {
  AnalysisHeading,
  AnalysisInputFingerprint,
  DecisionAnalysis,
  PersistedDecisionAnalysis,
} from "@stll/legal-ast/analysis";
import {
  analysisHeadingInputSchema,
  parsePersistedDecisionAnalysis,
} from "@stll/legal-ast/analysis";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { parseUsableDocumentAst } from "@stll/legal-ast/document-ast";

// SAFETY: rootDb is used only inside runGeneration, which runs in
// a fire-and-forget background task after the request scope has
// ended.
// eslint-disable-next-line no-restricted-imports -- background task outlives the request scope; no ctx.scopedDb available
import { rootDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import {
  devReparseEnabled,
  reparseForDev,
} from "@/api/handlers/case-law/decisions/dev-reparse";
import { resolveCaching, type OrgAIConfig } from "@/api/lib/ai-config";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  analysisInputFingerprint,
  formatDecisionForPrompt,
} from "@/api/lib/case-law/analysis-prompt";
import { readDecisionAnalysis } from "@/api/lib/case-law/decision-analysis";
import { tSafeId } from "@/api/lib/custom-schema";
import { detached } from "@/api/lib/detached";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { allowsDerivedAi } from "@/api/lib/legal-search/corpus-source";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import {
  getTanStackTextModelForRole,
  requireTanStackAIAvailableForRole,
} from "@/api/lib/tanstack-ai-models";

import { normalizeAnalysisHeadingLabels } from "./category-catalog";
import { getSystemPrompt } from "./prompts/prompt-registry";
import {
  analysisSentinel,
  claimableAnalysisRow,
  storedAnalysisFingerprint,
  storedAnalysisState,
  type AnalysisStoreKey,
} from "./stored-analysis";

/**
 * What the model is shown, and the fingerprint a stored analysis must
 * carry to count as computed over it.
 */
type AnalysisInput = {
  decisionText: string;
  fingerprint: AnalysisInputFingerprint;
};

const analysisInputOf = (ast: DocumentAst): AnalysisInput => {
  const decisionText = formatDecisionForPrompt(ast.blocks);
  return { decisionText, fingerprint: analysisInputFingerprint(decisionText) };
};

/**
 * Where an analysis and its in-flight sentinel live: the decision row in
 * the local database, normally. A shared corpus read through the read-only
 * handle cannot take that write, so production reports the analysis
 * unavailable there, and a development process keeps it in memory instead.
 *
 * Every write is keyed by the input fingerprint as well as the decision:
 * the row may have been re-parsed since a run began, and a run's result
 * or sentinel cleanup must then leave the newer parse's state alone.
 */
type AnalysisStore = {
  /**
   * Takes the row for a run over `fingerprint`. False when the row already
   * holds a live sentinel or a finished analysis for that same input.
   */
  claim: (key: AnalysisStoreKey) => Promise<boolean>;
  /** Stores the result, only where the row still carries its fingerprint. */
  save: (
    decisionId: SafeId<"caseLawDecision">,
    analysis: DecisionAnalysis,
  ) => Promise<void>;
  /** Releases this run's sentinel, and only this run's. */
  clear: (key: AnalysisStoreKey) => Promise<void>;
  /** What the store holds beside the row; null where the row is the store. */
  peek: (decisionId: SafeId<"caseLawDecision">) => unknown;
};

const dbAnalysisStore: AnalysisStore = {
  claim: async ({ decisionId, fingerprint }) => {
    // audit: skip — background AI analysis sentinel; no user-facing state change
    const now = new Date();
    const [updated] = await rootDb
      .update(caseLawDecisions)
      .set({ analysis: analysisSentinel(fingerprint, now) })
      .where(claimableAnalysisRow({ decisionId, fingerprint, now }))
      .returning({ id: caseLawDecisions.id });
    return updated !== undefined;
  },
  // Use rootDb (not scopedDb) because case-law analysis is global,
  // not workspace-scoped.
  save: async (decisionId, analysis) => {
    // audit: skip — background AI analysis output; no user-facing state change
    await rootDb
      .update(caseLawDecisions)
      .set({ analysis })
      .where(
        and(
          eq(caseLawDecisions.id, decisionId),
          sql`${storedAnalysisFingerprint} = ${analysis.inputFingerprint}`,
        ),
      );
  },
  clear: async ({ decisionId, fingerprint }) => {
    // audit: skip — background AI analysis sentinel cleanup; no user-facing state change
    await rootDb
      .update(caseLawDecisions)
      .set({ analysis: null })
      .where(
        and(
          eq(caseLawDecisions.id, decisionId),
          sql`${caseLawDecisions.analysis}->>'status' = 'generating'`,
          sql`${storedAnalysisFingerprint} = ${fingerprint}`,
        ),
      );
  },
  peek: () => null,
};

const memoryAnalyses = new Map<SafeId<"caseLawDecision">, unknown>();

const memoryAnalysisStore: AnalysisStore = {
  claim: async ({ decisionId, fingerprint }) => {
    const now = new Date();
    const state = storedAnalysisState({
      stored: memoryAnalyses.get(decisionId),
      fingerprint,
      now,
    });
    if (state.kind !== "none") {
      return await Promise.resolve(false);
    }
    memoryAnalyses.set(decisionId, analysisSentinel(fingerprint, now));
    return await Promise.resolve(true);
  },
  save: async (decisionId, analysis) => {
    const held = parsePersistedDecisionAnalysis(memoryAnalyses.get(decisionId));
    if (held?.inputFingerprint === analysis.inputFingerprint) {
      memoryAnalyses.set(decisionId, analysis);
    }
    await Promise.resolve();
  },
  clear: async ({ decisionId, fingerprint }) => {
    const held = parsePersistedDecisionAnalysis(memoryAnalyses.get(decisionId));
    if (
      held !== null &&
      "status" in held &&
      held.inputFingerprint === fingerprint
    ) {
      memoryAnalyses.delete(decisionId);
    }
    await Promise.resolve();
  },
  peek: (decisionId) => memoryAnalyses.get(decisionId) ?? null,
};

const readsSharedCorpus = (): boolean =>
  envBase.PUBLIC_LAW_DATABASE_URL !== undefined;

const analysisStore = (): AnalysisStore =>
  readsSharedCorpus() ? memoryAnalysisStore : dbAnalysisStore;

type StreamedAnalysisHeading = Omit<AnalysisHeading, "children">;

const analysisOutputSchema = v.strictObject({
  headings: v.array(analysisHeadingInputSchema),
});

const createAnalysisHeading = ({
  heading,
  language,
}: {
  heading: StreamedAnalysisHeading;
  language: string;
}): AnalysisHeading =>
  normalizeAnalysisHeadingLabels({
    heading: {
      id: Bun.randomUUIDv7(),
      label: heading.label,
      category: heading.category,
      startAnchorId: heading.startAnchorId,
      endAnchorId: heading.endAnchorId,
      annotations: heading.annotations.map((annotation) => ({
        id: Bun.randomUUIDv7(),
        summary: annotation.summary,
        startAnchorId: annotation.startAnchorId,
        endAnchorId: annotation.endAnchorId,
        textSnippet: annotation.textSnippet,
      })),
      children: [],
    },
    language,
  });

/**
 * Run the AI generation in the background. Updates the DB
 * when done; clears the sentinel on failure.
 *
 * `orgAIConfig` is captured from the request scope and threaded
 * through here so BYOK orgs route this fire-and-forget call to
 * their own provider key. Snapshot semantics are intentional: a
 * config change made during the in-flight generation does not
 * retarget mid-run.
 */
const runGeneration = async (
  decisionId: SafeId<"caseLawDecision">,
  input: AnalysisInput,
  decision: {
    court: string;
    country: string;
    language: string;
    decisionType: string | null;
  },
  organizationId: SafeId<"organization">,
  orgAIConfig: OrgAIConfig | null,
  promptCachingEnabled: boolean,
) => {
  // audit: skip — background AI analysis output
  const systemPrompt = getSystemPrompt(decision.language);

  const userMessage = `Court: ${decision.court}
Country: ${decision.country}
Type: ${decision.decisionType ?? "unknown"}

${input.decisionText}`;

  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    feature: "case-law.analysis",
    modelRole: "fast",
    organizationId,
    orgAIConfig,
    properties: {
      decision_id: decisionId,
      jurisdiction: decision.country,
      language: decision.language,
      organization_id: organizationId,
    },
    sessionId: decisionId,
    traceId: Bun.randomUUIDv7(),
  });

  try {
    const { modelId } = getTanStackTextModelForRole("fast", orgAIConfig, {
      organizationId,
    });
    const result = await generateTanStackObjectForRole({
      role: "fast",
      serviceTier: "standard",
      orgAIConfig,
      organizationId,
      // Case-law analysis is global, not workspace-scoped (see rootDb use below).
      tenantWorkspaceIds: [],
      analytics: aiAnalytics,
      caching: resolveCaching({
        promptCachingEnabled,
        role: "fast",
        scopeKey: decisionId,
      }),
      system: systemPrompt,
      prompt: userMessage,
      outputSchema: analysisOutputSchema,
      abortSignal: AbortSignal.timeout(120_000),
    });

    // Assign stable IDs at push time so they don't change across persists
    const headings = result.headings.map((heading) =>
      createAnalysisHeading({
        heading,
        language: decision.language,
      }),
    );

    const analysis: DecisionAnalysis = {
      version: 2,
      generatedAt: new Date().toISOString(),
      model: modelId,
      inputFingerprint: input.fingerprint,
      tree: headings,
    };

    await analysisStore().save(decisionId, analysis);
  } catch (error) {
    captureError(error, {
      source: "case-law-analysis",
      decisionId,
    });
    aiAnalytics.captureError(error);
    await analysisStore()
      .clear({ decisionId, fingerprint: input.fingerprint })
      .catch((cleanupError: unknown) => {
        // Best-effort sentinel cleanup. Capture rather than swallow: a
        // failure here leaves the decision pinned in the generating state,
        // which is a distinct fault from the one the outer catch reported.
        captureError(cleanupError, {
          source: "case-law-analysis-sentinel-cleanup",
          decisionId,
        });
      });
  }
};

type GenerateAnalysisResponse = {
  status: "done" | "error" | "generating";
  analysis?: PersistedDecisionAnalysis;
  error?: string;
};

export const generateAnalysis = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
  orgAIConfig: OrgAIConfig | null,
  orgAIConfigStatus: OrgAIConfigStatus,
  promptCachingEnabled: boolean,
): Promise<Result<GenerateAnalysisResponse, HandlerError>> => {
  // audit: skip — background AI analysis output
  const decision =
    envBase.PUBLIC_LAW_DATABASE_URL === undefined
      ? await scopedDb(async (tx) => await readDecisionAnalysis(tx, decisionId))
      : await caseLawPublicReadDb(
          async (tx) => await readDecisionAnalysis(tx, decisionId),
        );

  if (!decision) {
    return Result.ok({ status: "error", error: "Decision not found" });
  }

  // The text the reader sees: in development that may be the tree's own
  // parse rather than the stored one, and the anchors must agree. Resolved
  // before the stored analysis is consulted, because whether that analysis
  // still applies is a property of this text.
  const reparsed =
    devReparseEnabled() && decision.source !== null
      ? await reparseForDev({
          adapterKey: decision.source.adapterKey,
          caseNumber: decision.caseNumber,
          court: decision.court,
          decisionDate: decision.decisionDate,
          decisionType: decision.decisionType,
          documentUrl: decision.documentUrl,
          ecli: decision.ecli,
          id: decisionId,
          metadata: decision.metadata,
        })
      : null;
  const ast = reparsed ?? parseUsableDocumentAst(decision.documentAst);
  if (ast === null) {
    return Result.ok({
      status: "error",
      error: "Decision has no parseable AST",
    });
  }
  const input = analysisInputOf(ast);

  const stored = storedAnalysisState({
    stored: analysisStore().peek(decisionId) ?? decision.analysis,
    fingerprint: input.fingerprint,
    now: new Date(),
  });
  switch (stored.kind) {
    case "done":
      return Result.ok({ status: "done", analysis: stored.analysis });
    case "generating":
      return Result.ok({ status: "generating" });
    case "none":
      break;
    default: {
      const exhaustive: never = stored;
      return exhaustive;
    }
  }

  // A shared corpus connection is deliberately read-only. It may serve an
  // analysis already persisted by the owning environment, but this process
  // must never try to create or update one in that database. A development
  // process keeps its analyses in memory instead (`memoryAnalysisStore`).
  if (readsSharedCorpus() && !envBase.isDev) {
    return Result.ok({
      status: "error",
      error: "Analysis is unavailable for this decision",
    });
  }

  // Sources carry different reuse terms. One whose terms withhold derived AI
  // use is still read and served; its text is never sent to a model. Decided
  // before AI availability because it is a property of the decision, not of
  // how this deployment is configured.
  if (
    decision.source === null ||
    !allowsDerivedAi(decision.source.descriptor)
  ) {
    return Result.ok({
      status: "error",
      error: "Analysis is unavailable for this decision",
    });
  }

  // AI availability is checked only on the path that actually invokes the
  // model: the stored and in-flight reads above must stay accessible when
  // the fast role is unavailable (a pre-existing bug ran this check before
  // them, locking finished analyses behind AI configuration).
  const available = requireTanStackAIAvailableForRole({
    configStatus: orgAIConfigStatus,
    orgConfig: orgAIConfig,
    role: "fast",
  });
  if (Result.isError(available)) {
    return Result.err(available.error);
  }

  // Another request won the race: return generating.
  if (
    !(await analysisStore().claim({
      decisionId,
      fingerprint: input.fingerprint,
    }))
  ) {
    return Result.ok({ status: "generating" });
  }

  // Fire-and-forget generation
  detached(
    runGeneration(
      decisionId,
      input,
      decision,
      organizationId,
      orgAIConfig,
      promptCachingEnabled,
    ),
    "analysis-generate.run-generation",
  );

  return Result.ok({ status: "generating" });
};

const config = {
  description:
    "Read the structural analysis of one court decision, starting generation " +
    "when there is none yet. Returns status done with the stored analysis, " +
    "generating while a run is in flight (poll until it is done), or error " +
    "when the decision is unknown or its text could not be parsed. " +
    "Generation runs in the background and a call made while one is already " +
    "running does not start a second.",
  permissions: { workspace: ["read"], chat: ["create"] },
  mcp: { type: "capability", reason: "legal_corpus_admin" },
  // Writes a "generating" sentinel and kicks off background AI generation
  // that updates the decision row.
  access: "write",
  params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
} satisfies HandlerConfig;

const generateDecisionAnalysis = createSafeRootHandler(
  config,
  async function* ({
    params: { decisionId },
    session,
    scopedDb,
    orgAIConfig,
    orgAIConfigStatus,
    promptCachingEnabled,
  }) {
    // AI availability is enforced inside generateAnalysis, after its stored
    // and in-flight branches, so finished analyses stay readable when the
    // fast model role is unavailable.
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await generateAnalysis(
            decisionId,
            scopedDb,
            session.activeOrganizationId,
            orgAIConfig,
            orgAIConfigStatus,
            promptCachingEnabled,
          ),
      ),
    );

    return response;
  },
);

export default generateDecisionAnalysis;
