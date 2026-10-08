/**
 * Generate AI analysis for a court decision.
 *
 * Returns the stored analysis when it was computed over the document as
 * it reads today. Otherwise kicks off background generation and returns
 * 202. The frontend polls until the analysis is ready, or until the run's
 * failure record tells it why there is none.
 */

import { panic, Result } from "better-result";
import { t } from "elysia";

import type {
  CaseLawAnalysisFailureCode as AnalysisFailureCode,
  CaseLawAnalysisUnavailableCode,
} from "@stll/api-contract";
import type {
  AnalysisGenerating,
  DecisionAnalysis,
} from "@stll/legal-ast/analysis";

import type { ScopedDb } from "@/api/db/safe-db";
import { resolveCaching, type OrgAIConfig } from "@/api/lib/ai-config";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import {
  classifyAIError,
  isUnanticipatedAIFailure,
  type AIErrorKind,
} from "@/api/lib/ai-error";
import { captureError, detached } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import {
  analysisFailureKeyTag,
  failureClaimGuard,
  analysisFailureRecord,
  failureStillHolds,
  type AnalysisFailureRecord,
  type AnalysisReaderKey,
} from "@/api/lib/case-law/analysis-failure";
import type { AnalysisInput } from "@/api/lib/case-law/analysis-prompt";
import {
  analysisStore,
  storesAnalyses,
  type AnalysisStore,
} from "@/api/lib/case-law/analysis-store";
import { storedAnalysisState } from "@/api/lib/case-law/stored-analysis";
import { tSafeId } from "@/api/lib/custom-schema";
import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createDetachedModelActionStarter,
  createModelActionAdmitter,
  type DetachedModelActionStarter,
  type ModelActionAdmitter,
} from "@/api/lib/rate-limit/model-action-admission";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import {
  getTanStackTextModelInfoForRole,
  requireTanStackAIAvailableForRole,
  type ResolvedTanStackTextModel,
} from "@/api/lib/tanstack-ai-models";

import { resolveAnalysisInput } from "./analysis-input";
import { analysisOutputSchema, buildDecisionAnalysis } from "./analysis-output";
import { allowsDerivedAiAnalysis } from "./analysis-update";
import { refreshSignificance } from "./significance-run";

/**
 * How long one analysis run may take before it fails as timed out. An
 * analysis is about 2.6k output tokens; a fast-role model writes that in well
 * under half a minute, so 45 s leaves room for a slow provider without
 * holding the reader on a spinner for the two minutes a stuck run took.
 * Far inside the sentinel's own hold (`SENTINEL_STALE_MS`), so a run always
 * settles its sentinel before another request may take the row over.
 */
export const ANALYSIS_GENERATION_DEADLINE_MS = 45_000;

/**
 * The output an analysis needs, in tokens: about six times the ~2.6k a full
 * analysis takes, so the visible answer fits beside whatever reasoning the
 * model spends inside the same allowance. Bounded per model by the catalog's
 * output limit at dispatch (`outputTokensWithinModelLimit`), and kept below
 * the size a non-streaming provider call refuses outright.
 */
export const ANALYSIS_OUTPUT_TOKEN_BUDGET = 16_384;

/**
 * What a failed run tells the reader, by how the model call failed. Total
 * over the kinds, so a new kind is a decision here rather than a silent
 * "failed".
 */
export const ANALYSIS_FAILURE_CODE_BY_KIND = {
  output_incomplete: "answer_incomplete",
  output_invalid: "answer_incomplete",
  provider_stream_incomplete: "answer_incomplete",
  empty_completion: "answer_incomplete",
  loop_detected: "answer_incomplete",
  deadline_exceeded: "timed_out",
  quota_exhausted: "provider_refused",
  provider_billing: "provider_refused",
  provider_credentials_rejected: "provider_refused",
  model_unavailable: "provider_refused",
  provider_unavailable: "provider_unavailable",
  unknown: "failed",
} as const satisfies Record<AIErrorKind, AnalysisFailureCode>;

const ANALYSIS_FAILURE_MESSAGE = {
  answer_incomplete: "The AI model returned an incomplete answer",
  timed_out: "The AI model did not answer in time",
  provider_refused: "The AI provider refused the request",
  provider_unavailable: "The AI provider was unavailable",
  failed: "The analysis could not be generated",
} as const satisfies Record<AnalysisFailureCode, string>;

/** Why there is no analysis to show and none will be started. */
type AnalysisUnavailableCode = CaseLawAnalysisUnavailableCode;

/** Whose key a failed run used, as a reader may be told. */
type AnalysisFailureKeyView =
  | { source: "organization"; provider: string }
  | { source: "platform" };

export type GenerateAnalysisResponse =
  | { status: "done"; analysis: DecisionAnalysis }
  | { status: "generating" }
  | { status: "error"; code: AnalysisUnavailableCode; error: string }
  | {
      status: "error";
      code: AnalysisFailureCode;
      error: string;
      key: AnalysisFailureKeyView;
    };

const failureResponse = (
  failure: AnalysisFailureRecord,
): GenerateAnalysisResponse => {
  const view: AnalysisFailureKeyView =
    failure.keySource === "organization" && failure.provider !== null
      ? { source: "organization", provider: failure.provider }
      : { source: "platform" };
  const base = ANALYSIS_FAILURE_MESSAGE[failure.code];
  return {
    status: "error",
    code: failure.code,
    error:
      view.source === "organization"
        ? `${base} using your organization's ${view.provider} key`
        : base,
    key: view,
  };
};

const unavailable = (
  code: AnalysisUnavailableCode,
  error: string,
): GenerateAnalysisResponse => ({ status: "error", code, error });

/**
 * The key a reader's run would call the provider with: the organization's
 * own fast-role provider when it configured one, the platform's otherwise.
 * The same rule `getTanStackTextModelInfoForRole` dispatches by.
 */
const readerKeyOf = ({
  orgAIConfig,
  organizationId,
}: {
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
}): AnalysisReaderKey =>
  orgAIConfig === null
    ? { source: "platform" }
    : {
        source: "organization",
        organizationId,
        provider: orgAIConfig.overrideModels.fast.provider,
      };

/**
 * Run the AI generation in the background. Updates the DB when done; on
 * failure files the failure under the reader's key and releases the sentinel.
 *
 * `orgAIConfig` is captured from the request scope and threaded
 * through here so BYOK orgs route this fire-and-forget call to
 * their own provider key. Snapshot semantics are intentional: a
 * config change made during the in-flight generation does not
 * retarget mid-run.
 */
type RunGenerationOptions = {
  decisionId: SafeId<"caseLawDecision">;
  input: AnalysisInput;
  /** Anchor ids of the parse the input was built over, in reading order. */
  anchorIds: readonly string[];
  country: string;
  /** The row's `contentHash` at claim time; the save is fenced on it. */
  contentHash: string | null;
  /** The sentinel the claim wrote; cleanup releases exactly this one. */
  sentinel: AnalysisGenerating;
  organizationId: SafeId<"organization">;
  admission: ModelDispatchAdmission;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  reader: AnalysisReaderKey;
  store: AnalysisStore;
  resolveTextModel: AnalysisModelResolver | undefined;
  deadlineMs: number;
};

/** External model-resolution boundary; supplied by focused tests only. */
type AnalysisModelResolver = () =>
  | ResolvedTanStackTextModel
  | Promise<ResolvedTanStackTextModel>;

const runGeneration = async ({
  admission,
  anchorIds,
  contentHash,
  country,
  deadlineMs,
  decisionId,
  input,
  orgAIConfig,
  organizationId,
  promptCachingEnabled,
  reader,
  resolveTextModel,
  sentinel,
  store,
}: RunGenerationOptions) => {
  // audit: skip — background AI analysis output
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    dataClass: "public_corpus",
    feature: "case-law.analysis",
    modelRole: "fast",
    organizationId,
    orgAIConfig,
    properties: {
      decision_id: decisionId,
      jurisdiction: country,
      language: input.language,
      organization_id: organizationId,
    },
    sessionId: decisionId,
    traceId: Bun.randomUUIDv7(),
  });

  try {
    const { modelId } = getTanStackTextModelInfoForRole("fast", orgAIConfig, {
      dataClass: "public_corpus",
      organizationId,
    });
    const result = await generateTanStackObjectForRole({
      dataClass: "public_corpus",
      role: "fast",
      serviceTier: "standard",
      orgAIConfig,
      organizationId,
      admission,
      // Case-law analysis is global, not workspace-scoped (see the store).
      tenantWorkspaceIds: [],
      analytics: aiAnalytics,
      caching: resolveCaching({
        promptCachingEnabled,
        role: "fast",
        scopeKey: decisionId,
      }),
      system: input.systemPrompt,
      prompt: input.userMessage,
      outputSchema: analysisOutputSchema,
      outputTokenBudget: ANALYSIS_OUTPUT_TOKEN_BUDGET,
      deadlineMs,
      ...(resolveTextModel === undefined ? {} : { resolveTextModel }),
    });

    const analysis = buildDecisionAnalysis({
      anchorIds,
      output: result,
      language: input.language,
      model: modelId,
      inputFingerprint: input.fingerprint,
      generatedAt: new Date(),
    });

    await store.save({ analysis, contentHash, decisionId });
  } catch (error) {
    // Named outcomes (an incomplete answer, a deadline, a provider refusal)
    // are recorded by the analytics callbacks and told to the reader; only
    // an unanticipated shape is an exception worth capturing.
    if (isUnanticipatedAIFailure(error)) {
      captureError(error, {
        source: "case-law-analysis",
        decisionId,
      });
    }
    aiAnalytics.captureError(error);
    const failure = analysisFailureRecord({
      code: ANALYSIS_FAILURE_CODE_BY_KIND[classifyAIError(error)],
      fingerprint: sentinel.inputFingerprint,
      now: new Date(),
      reader,
    });
    await recordFailedRun({
      decisionId,
      failure,
      keyTag: analysisFailureKeyTag(reader, decisionId),
      sentinel,
      store,
    });
  }
};

/**
 * Files the run's failure under its reader key and releases its sentinel.
 * When the record cannot be written, releases the sentinel anyway rather than
 * leave the decision pinned in the generating state, and captures what went
 * wrong: neither is the fault the run itself failed on.
 */
const recordFailedRun = async ({
  decisionId,
  failure,
  keyTag,
  sentinel,
  store,
}: {
  decisionId: SafeId<"caseLawDecision">;
  failure: AnalysisFailureRecord;
  keyTag: string;
  sentinel: AnalysisGenerating;
  store: AnalysisStore;
}): Promise<void> => {
  const recorded = await Result.tryPromise(
    async () => await store.fail({ decisionId, failure, keyTag, sentinel }),
  );
  if (Result.isOk(recorded)) {
    return;
  }
  const released = await Result.tryPromise(
    async () => await store.clear({ decisionId, sentinel }),
  );
  captureError(
    Result.isOk(released)
      ? recorded.error
      : new AggregateError(
          [recorded.error, released.error],
          "The failed run's record could not be written nor its sentinel released",
        ),
    { source: "case-law-analysis-failure-record", decisionId },
  );
};

type GenerateAnalysisOptions = {
  /** Admits a background significance refresh. */
  admitModelAction: ModelActionAdmitter;
  /** Admits a new generation, held until it settles after the response. */
  startModelAction: DetachedModelActionStarter;
  decisionId: SafeId<"caseLawDecision">;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  orgAIConfigStatus: OrgAIConfigStatus;
  promptCachingEnabled: boolean;
  /**
   * The reader asked to run again after a failure. Without it, a failure
   * record over this document answers for its hold, so polling never starts
   * the run that just failed a second time.
   */
  retry: boolean;
  /** Where the analysis lives; the application's store unless a test says. */
  store?: AnalysisStore | undefined;
  /** External model-resolution boundary; supplied by focused tests only. */
  resolveTextModel?: AnalysisModelResolver | undefined;
  /** The run's deadline; `ANALYSIS_GENERATION_DEADLINE_MS` unless a test says. */
  deadlineMs?: number | undefined;
  /**
   * Test seam: runs between the read and the claim, so a test can settle
   * another request's run in that window. Never set outside tests.
   */
  beforeClaim?: (() => Promise<void>) | undefined;
};

export const generateAnalysis = async ({
  admitModelAction,
  startModelAction,
  decisionId,
  scopedDb,
  organizationId,
  orgAIConfig,
  orgAIConfigStatus,
  promptCachingEnabled,
  retry,
  store = analysisStore(),
  resolveTextModel,
  deadlineMs = ANALYSIS_GENERATION_DEADLINE_MS,
  beforeClaim,
}: GenerateAnalysisOptions): Promise<
  Result<GenerateAnalysisResponse, ActionAdmissionError | HandlerError>
> => {
  // audit: skip — background AI analysis output
  const resolution = await resolveAnalysisInput({ decisionId, scopedDb });
  switch (resolution.kind) {
    case "decision-not-found":
      return Result.ok(unavailable("decision_not_found", "Decision not found"));
    case "unparseable-document":
      return Result.ok(
        unavailable("document_unparseable", "Decision has no parseable AST"),
      );
    case "unsupported-language":
      return Result.ok(
        unavailable(
          "language_unsupported",
          `Analysis is not available for decisions in language "${resolution.language}"`,
        ),
      );
    case "resolved":
      break;
    default: {
      resolution satisfies never;
      return panic(`Unhandled resolution: ${String(resolution)}`);
    }
  }
  const { anchorIds, decision, input } = resolution;
  const reader = readerKeyOf({ orgAIConfig, organizationId });

  const observed = store.peek(decisionId) ?? decision.analysis;
  const stored = storedAnalysisState({
    stored: observed,
    fingerprint: input.fingerprint,
    now: new Date(),
  });
  switch (stored.kind) {
    case "done":
      // The document layers are settled; the graph one may not be. Fenced
      // on the citation graph and written in the background, so a reader
      // never waits for it and a decision whose neighbourhood has not
      // moved costs one indexed query.
      if (storesAnalyses()) {
        detached(
          refreshSignificance({
            admitModelAction,
            analysis: stored.analysis,
            contentHash: decision.contentHash,
            decisionId,
            orgAIConfig,
            orgAIConfigStatus,
            organizationId,
            promptCachingEnabled,
          }),
          "analysis-generate.refresh-significance",
        );
      }
      return Result.ok({ status: "done", analysis: stored.analysis });
    case "generating":
      return Result.ok({ status: "generating" });
    case "none":
      break;
    default: {
      stored satisfies never;
      return panic(`Unhandled stored: ${String(stored)}`);
    }
  }

  // Before a run starts: when the run this reader's key made last failed,
  // say so until the reader asks again. The record is filed under this
  // reader's key alone, so another reader's run on the shared row neither
  // replaces nor clears it, and this reader never re-runs unasked.
  const applicableFailure = async (): Promise<AnalysisFailureRecord | null> => {
    const failure = await store.readFailure({
      decisionId,
      keyTag: analysisFailureKeyTag(reader, decisionId),
    });
    return failure !== null &&
      failureStillHolds({
        failure,
        fingerprint: input.fingerprint,
        now: new Date(),
        reader,
      })
      ? failure
      : null;
  };
  if (!retry) {
    const failure = await applicableFailure();
    if (failure !== null) {
      return Result.ok(failureResponse(failure));
    }
  }

  if (!storesAnalyses()) {
    return Result.ok(
      unavailable(
        "analysis_unavailable",
        "Analysis is unavailable for this decision",
      ),
    );
  }

  // Sources carry different reuse terms. One whose terms withhold derived AI
  // use is still read and served; its text is never sent to a model. Decided
  // before AI availability because it is a property of the decision, not of
  // how this deployment is configured.
  if (!allowsDerivedAiAnalysis(decision)) {
    return Result.ok(
      unavailable(
        "analysis_unavailable",
        "Analysis is unavailable for this decision",
      ),
    );
  }

  // AI availability is checked only on the path that actually invokes the
  // model: the stored and in-flight reads above must stay accessible when
  // the fast role is unavailable (a pre-existing bug ran this check before
  // them, locking finished analyses behind AI configuration).
  const available = requireTanStackAIAvailableForRole({
    dataClass: "public_corpus",
    configStatus: orgAIConfigStatus,
    orgConfig: orgAIConfig,
    role: "fast",
  });
  if (Result.isError(available)) {
    return Result.err(available.error);
  }

  await beforeClaim?.();

  // The generation draws one action when it starts and holds it until the
  // background run settles, after this request has answered.
  const started = await startModelAction({
    label: "analysis-generate.run-generation",
    // Another request won the race when the claim returns null. A plain
    // read's claim also refuses, in the same statement, while this reader's
    // key has an applicable failure: one filed after the read above, by a
    // run that started and failed meanwhile, still stops it.
    start: async () =>
      await store.claim({
        decisionId,
        fingerprint: input.fingerprint,
        observed,
        ...(retry
          ? {}
          : {
              unlessFailed: failureClaimGuard({
                decisionId,
                now: new Date(),
                reader,
              }),
            }),
      }),
    // The proof aborts the generation's model call if the lease is lost.
    background: async ({ admission }, sentinel) => {
      if (sentinel === null) {
        return;
      }
      await runGeneration({
        admission,
        anchorIds,
        contentHash: decision.contentHash,
        country: decision.country,
        deadlineMs,
        decisionId,
        input,
        orgAIConfig,
        organizationId,
        promptCachingEnabled,
        reader,
        resolveTextModel,
        sentinel,
        store,
      });
    },
  });
  if (Result.isError(started)) {
    return Result.err(
      ActionAdmissionError.is(started.error)
        ? started.error
        : new HandlerError({
            status: 503,
            message: "Analysis generation could not start",
            cause: started.error,
          }),
    );
  }

  // A claim lost to a failure filed since the read answers that failure;
  // one lost to another run answers that run in flight.
  if (started.value === null && !retry) {
    const failure = await applicableFailure();
    if (failure !== null) {
      return Result.ok(failureResponse(failure));
    }
  }
  return Result.ok({ status: "generating" });
};

const config = {
  description:
    "Read the structural analysis of one court decision, starting generation " +
    "when there is none yet. Returns status done with the stored analysis, " +
    "generating while a run is in flight (poll until it is done), or error " +
    "with a code: decision_not_found, document_unparseable, " +
    "language_unsupported or analysis_unavailable when no analysis can be " +
    "made; answer_incomplete, timed_out, provider_refused, " +
    "provider_unavailable or failed when the last run failed, with key " +
    "naming whose AI key it used (the organization's own, or the platform's). " +
    "A failed run answers until the call passes retry=true, which starts a " +
    "new one. Generation runs in the background and a call made while one " +
    "is already running does not start a second.",
  permissions: { workspace: ["read"], chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "legal_corpus_admin",
    consumesServices: true,
  },
  // Writes a "generating" sentinel and kicks off background AI generation
  // that updates the decision row.
  access: "write",
  params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
  query: t.Object({ retry: t.Optional(t.BooleanString()) }),
} satisfies HandlerConfig;

const generateDecisionAnalysis = createSafeRootHandler(
  config,
  async function* ({
    params: { decisionId },
    query,
    session,
    scopedDb,
    orgAIConfig,
    orgAIConfigStatus,
    promptCachingEnabled,
    user,
  }) {
    // AI availability is enforced inside generateAnalysis, after its stored
    // and in-flight branches, so finished analyses stay readable when the
    // fast model role is unavailable.
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await generateAnalysis({
            // Both runs continue after the response, outside its admission.
            admitModelAction: createModelActionAdmitter({
              organizationId: session.activeOrganizationId,
              userId: user.id,
              organizationStateDb: scopedDb,
              actionKind: "case-law.analysis",
              scope: "independent",
            }),
            startModelAction: createDetachedModelActionStarter({
              organizationId: session.activeOrganizationId,
              userId: user.id,
              organizationStateDb: scopedDb,
              actionKind: "case-law.analysis",
            }),
            decisionId,
            scopedDb,
            organizationId: session.activeOrganizationId,
            orgAIConfig,
            orgAIConfigStatus,
            promptCachingEnabled,
            retry: query.retry === true,
          }),
      ),
    );

    return response;
  },
);

export default generateDecisionAnalysis;
