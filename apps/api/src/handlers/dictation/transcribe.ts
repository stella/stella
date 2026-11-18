import { Result } from "better-result";
import type * as v from "valibot";

import {
  defaultTranscriptionModelId,
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
  transcriptionEndpointFor,
} from "@stll/ai-catalog/transcription";
import type { TranscriptionEndpoint } from "@stll/ai-catalog/transcription";
import { AI_FAILURE_CODES } from "@stll/api-contract";
import type { DesktopFeatureId } from "@stll/api-contract/desktop-feature-access";
import {
  MAX_TRANSCRIPTION_AUDIO_SECONDS,
  MAX_TRANSCRIPTION_MULTIPART_BYTES,
  TRANSCRIPTION_AUDIO_MEDIA_TYPES,
  TRANSCRIPTION_DURATION_TOLERANCE_MS,
  TRANSCRIPTION_LABELS_SHOWN_FIELD,
} from "@stll/api-contract/transcription";
import { workspaceIsVisible } from "@stll/api-contract/workspace-status";
import { classifyFailure } from "@stll/errors";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { transcribeWithElevenLabs } from "@/api/handlers/dictation/elevenlabs-provider";
import { consumeDictationLimit } from "@/api/handlers/dictation/limits";
import {
  transcribeAudio,
  transcriptionResultSchema,
} from "@/api/handlers/dictation/provider";
import type { TranscriptionResult } from "@/api/handlers/dictation/provider";
import { dictationBodySchema } from "@/api/handlers/dictation/schema";
import {
  readTranscriptionDeployment,
  transcriptionServed,
} from "@/api/handlers/dictation/transcription-deployment";
import type { OrgSettingsForAuth } from "@/api/lib/ai-config-loader";
import { orgAIConfigStatusError } from "@/api/lib/ai-config-response";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeRootHandler,
  safeHandlerResponseSchemas,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import type { MemberCaller } from "@/api/lib/auth/member-caller";
import type { SafeId } from "@/api/lib/branded-types";
import { getManagedOpenRouterCredential } from "@/api/lib/chat/openrouter-credential";
import { managedProviderUnavailable } from "@/api/lib/chat/provider-data-policy";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  isFeatureAccessSnapshotForPrincipal,
  isFeatureEnabled,
} from "@/api/lib/feature-access/policy";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import { emitTranscriptionDurationMismatchMetric } from "@/api/lib/observability/request-metrics";
import type { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";
import { transcriptionUsageUnits } from "@/api/lib/usage/unit-model";
import {
  assertUsageAvailable,
  recordUsageEvent,
} from "@/api/lib/usage/usage-ledger";

// A model whose provider keeps the audio is offered to members with this
// decision only, on every client that warns about it. The API lists and
// refuses; the desktop only refreshes its model list when the decision
// changes.
export const RETAINING_MODELS_FEATURE_ID =
  "desktop-dictation-retaining-models" satisfies DesktopFeatureId;

/**
 * The member may use a model whose provider keeps the audio. The member's
 * feature decisions come with the request; a caller that arrives without
 * them for this member reads them, as handler feature admission does.
 */
export const readRetainingModelsGrant = async ({
  featureAccessSnapshot,
  safeDb,
  session,
  user,
}: {
  featureAccessSnapshot?: FeatureAccessSnapshot | undefined;
  safeDb: SafeDb;
  session: { activeOrganizationId: SafeId<"organization"> };
  user: { id: SafeId<"user"> };
}): Promise<Result<boolean, SafeDbError>> => {
  const principal = {
    organizationId: session.activeOrganizationId,
    userId: user.id,
  };
  const snapshot =
    featureAccessSnapshot !== undefined &&
    isFeatureAccessSnapshotForPrincipal(featureAccessSnapshot, principal)
      ? Result.ok(featureAccessSnapshot)
      : await safeDb(
          async (tx) =>
            await resolveFeatureAccessSnapshot({ tx, ...principal }),
        );
  return snapshot.map((decisions) =>
    isFeatureEnabled(decisions, RETAINING_MODELS_FEATURE_ID, principal),
  );
};

const config = {
  contract: "patch",
  description:
    "Transcribe one audio chunk without storing the audio or transcript. Upload file, an optional modelId (absent: the cheapest model offered in the organization's region), optional ISO 639-1 language, a JSON array of vocabulary terms, an optional matterId, and labels=1 only when the client showed the models list's outsideRegion and retainsData labels where the model was chosen. Available through REST multipart upload; generic JSON capability transports cannot upload audio.",
  permissions: { workspace: ["read"], chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  access: "write",
  realtime: noResourceSetUpdates(
    "Transcription text is transient; this operation changes no shared matter or document resources.",
  ),
  actionAdmission: { type: "handler", actionKind: "dictation.transcribe" },
  mcp: { type: "capability", reason: "assistant_chat", consumesServices: true },
  contentDelivery: {
    type: "none",
    reason: "Returns a transient transcription, not stored-file content.",
  },
  transport: {
    type: "file-input",
    input: {
      field: "file",
      required: true,
      mediaTypes: TRANSCRIPTION_AUDIO_MEDIA_TYPES,
    },
    alternative: {
      type: "none",
      reason: "Use POST /v1/dictation/transcribe with a multipart audio file.",
    },
  },
  requestTimeoutMs: 65_000,
  requestBodyMaxBytes: MAX_TRANSCRIPTION_MULTIPART_BYTES,
  body: dictationBodySchema,
  response: safeHandlerResponseSchemas(transcriptionResultSchema),
} as const satisfies HandlerConfig;

/** Who dictates: a signed-in member, or a linked desktop's account. */
type DictationIdentity = {
  readonly user: { readonly id: SafeId<"user"> };
  readonly session: { readonly activeOrganizationId: SafeId<"organization"> };
};

type UsageCaller = DictationIdentity &
  Pick<MemberCaller, "safeDb" | "recordAuditEvent"> & {
    /** The endpoint that served the audio, whose price is billed. */
    readonly transcriptionEndpoint: TranscriptionEndpoint;
  };

/** What transcription reads from its caller, whichever credential proved it. */
export type DictationCaller = Readonly<OrgSettingsForAuth> &
  DictationIdentity &
  Pick<MemberCaller, "safeDb" | "recordAuditEvent" | "getWorkspaceAccess"> & {
    /** A caller that shows members which models leave the region may send
     *  a model the region does not serve to the global endpoint. Only a
     *  model named in the request goes there; a default never does. */
    readonly allowOutsideRegion?: boolean;
    /** A caller that warns members when a provider keeps the audio may use
     *  such a model when it names it; a default never is one. */
    readonly allowRetainingModels?: boolean;
  };
type PreflightOptions = {
  caller: UsageCaller;
  isByok: boolean;
  required: number;
};
const checkUsage = async ({
  caller,
  isByok,
  required,
}: PreflightOptions): Promise<Result<void, HandlerError<402 | 503>>> => {
  if (isByok || !env.USAGE_ENFORCEMENT_ENABLED) {
    return Result.ok(undefined);
  }
  const checked = await caller.safeDb(
    async (tx) =>
      await assertUsageAvailable({
        tx,
        organizationId: caller.session.activeOrganizationId,
        required,
      }),
  );
  if (checked.isErr()) {
    return Result.err(
      classifyFailure(
        new HandlerError({
          status: 503,
          code: "service_unavailable",
          message: "Usage admission is unavailable",
          retryable: true,
        }),
        "organization_state_unreadable",
      ),
    );
  }
  if (checked.value.ok) {
    return Result.ok(undefined);
  }
  const { error } = checked.value;
  return Result.err(
    new HandlerError({
      status: 402,
      code: "usage_limit_exceeded",
      message: "Usage allowance is exhausted",
      usage: {
        reason: error.reason,
        required: error.required,
        available: error.available,
      },
    }),
  );
};

type SettleOptions = {
  caller: UsageCaller;
  result: Pick<TranscriptionResult, "modelId" | "durationMs">;
  workspaceId: SafeId<"workspace"> | null;
  isByok: boolean;
};
const settleUsage = async ({
  caller,
  result,
  workspaceId,
  isByok,
}: SettleOptions): Promise<Result<void, SafeDbError | HandlerError<503>>> => {
  if (!isTranscriptionModelId(result.modelId)) {
    return Result.err(managedProviderUnavailable("openrouter"));
  }
  const units = transcriptionUsageUnits({
    modelId: result.modelId,
    residency: caller.transcriptionEndpoint,
    durationMs: result.durationMs,
    isByok,
  });
  const requestId = Bun.randomUUIDv7();
  return await caller.safeDb(async (tx) => {
    await recordUsageEvent({
      tx,
      organizationId: caller.session.activeOrganizationId,
      workspaceId,
      userId: caller.user.id,
      actionType: "transcription",
      modelTask: "transcription",
      serviceTier: "standard",
      isByok,
      ...units,
      idempotencyKey: requestId,
    });
    await caller.recordAuditEvent(tx, {
      action: AUDIT_ACTION.EXECUTE,
      resourceType: AUDIT_RESOURCE_TYPE.USAGE_EVENT,
      resourceId: requestId,
      workspaceId,
      metadata: {
        operation: "dictation.transcribe",
        modelId: result.modelId,
        durationMs: result.durationMs,
      },
    });
  });
};

type DictationDependencies = {
  transcribe: typeof transcribeAudio;
  transcribeElevenLabs: typeof transcribeWithElevenLabs;
  deployment: typeof readTranscriptionDeployment;
  credential: typeof getManagedOpenRouterCredential;
  limit: typeof consumeDictationLimit;
  preflight: typeof checkUsage;
  settle: typeof settleUsage;
};

type DictationContext = DictationCaller & {
  body: v.InferOutput<typeof dictationBodySchema>;
  request: Request;
  modelAdmission?: ModelDispatchAdmission;
};

export type { DictationDependencies };

export const executeDictation = async (
  ctx: DictationContext,
  dependencies: DictationDependencies,
) =>
  await Result.gen(async function* () {
    const { body, session, user } = ctx;
    const configurationError = orgAIConfigStatusError(ctx.orgAIConfigStatus);
    if (configurationError !== null) {
      return Result.err(configurationError);
    }
    const workspaceId = body.matterId ?? null;
    if (workspaceId !== null) {
      const access = yield* Result.await(
        Result.tryPromise({
          try: async () => await ctx.getWorkspaceAccess(workspaceId),
          catch: () =>
            classifyFailure(
              new HandlerError({
                status: 503,
                code: "service_unavailable",
                message: "Matter access is unavailable",
              }),
              "organization_state_unreadable",
            ),
        }),
      );
      if (access === null || !workspaceIsVisible(access.status)) {
        return Result.err(
          new HandlerError({
            status: 404,
            code: "not_found",
            message: "Matter not found",
          }),
        );
      }
    }
    const ownKey = ctx.orgAIConfig?.providers.find(
      ({ provider }) => provider === "openrouter",
    )?.apiKey;
    if (ctx.orgAIConfig !== null && ownKey === undefined) {
      return Result.err(
        new HandlerError({
          status: 403,
          code: AI_FAILURE_CODES.own_key_required,
          message:
            "Transcription is not available with your organization's AI provider.",
          hint: "Configure an organization OpenRouter key in organization AI settings.",
        }),
      );
    }
    const deployment = dependencies.deployment();
    const served = transcriptionServed(deployment, ctx.orgAIConfig, {
      retainingData: ctx.allowRetainingModels === true,
    });
    const residency = ctx.managedAIResidency;
    const regionalDefault =
      residency === null
        ? undefined
        : defaultTranscriptionModelId(
            residency,
            transcriptionServed(deployment, ctx.orgAIConfig, {
              asDefault: true,
            }),
          );
    const modelId =
      residency === null ? undefined : (body.modelId ?? regionalDefault);
    const endpoint =
      residency === null || modelId === undefined
        ? undefined
        : transcriptionEndpointFor(modelId, residency, {
            outsideRegion:
              ctx.allowOutsideRegion === true && body.modelId !== undefined,
            served,
          });
    if (modelId === undefined || endpoint === undefined) {
      return Result.err(
        classifyFailure(
          new HandlerError({
            status: 503,
            code: "transcription_model_unavailable",
            message:
              body.modelId === undefined
                ? "No transcription model is available in your region"
                : "This transcription model is not available in your region",
            // Leaving the model out helps only where the region has a default.
            hint:
              regionalDefault === undefined
                ? "Transcription is not offered in your organization's region yet."
                : "Choose a transcription model available in your region, or leave the model out.",
          }),
          "model_unavailable",
        ),
      );
    }
    yield* Result.await(
      dependencies.limit({
        organizationId: session.activeOrganizationId,
        userId: user.id,
      }),
    );
    // A direct model runs on the deployment's key, never the organization's.
    const direct = TRANSCRIPTION_MODELS[modelId].route === "elevenlabs";
    const isByok = !direct && ownKey !== undefined;
    const maximumDurationMs = MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000;
    const usageCaller = {
      safeDb: ctx.safeDb,
      session,
      user,
      recordAuditEvent: ctx.recordAuditEvent,
      transcriptionEndpoint: endpoint,
    };
    yield* Result.await(
      dependencies.preflight({
        caller: usageCaller,
        isByok,
        required: transcriptionUsageUnits({
          modelId,
          residency: endpoint,
          durationMs: maximumDurationMs,
          isByok,
        }).unitsConsumed,
      }),
    );
    const admission = configuredModelAdmission(ctx);
    const scope = {
      admission,
      organizationId: session.activeOrganizationId,
      userId: user.id,
    };
    const transcribed = direct
      ? await dependencies.transcribeElevenLabs({
          audio: body.file,
          modelId,
          language: body.language,
          deployment: deployment.elevenLabs,
          scope,
          signal: ctx.request.signal,
        })
      : await dependencies.transcribe({
          audio: body.file,
          modelId,
          language: body.language,
          vocabulary: body.vocabulary,
          apiKey:
            ownKey ??
            (yield* Result.await(dependencies.credential(admission.modelTier)))
              .apiKey,
          residency: endpoint,
          scope,
          signal: ctx.request.signal,
        });
    const { transcript: result, admittedDurationMs } = yield* transcribed;
    const durationMismatch =
      result.durationMs >
      admittedDurationMs + TRANSCRIPTION_DURATION_TOLERANCE_MS;
    if (durationMismatch) {
      emitTranscriptionDurationMismatchMetric(modelId);
    }
    yield* Result.await(
      dependencies.settle({
        caller: usageCaller,
        result: {
          modelId: result.modelId,
          durationMs: durationMismatch
            ? result.durationMs
            : Math.min(result.durationMs, maximumDurationMs),
        },
        workspaceId,
        isByok,
      }),
    );
    return Result.ok(result);
  });

export const DEFAULT_DICTATION_DEPENDENCIES = {
  transcribe: transcribeAudio,
  transcribeElevenLabs: transcribeWithElevenLabs,
  deployment: readTranscriptionDeployment,
  credential: getManagedOpenRouterCredential,
  limit: consumeDictationLimit,
  preflight: checkUsage,
  settle: settleUsage,
} satisfies DictationDependencies;

export const createDictationTranscribeEndpoint = ({
  admit,
  transcribe = transcribeAudio,
  transcribeElevenLabs = transcribeWithElevenLabs,
  deployment = readTranscriptionDeployment,
  credential = getManagedOpenRouterCredential,
  limit = consumeDictationLimit,
  preflight = checkUsage,
  settle = settleUsage,
}: Partial<DictationDependencies> & {
  admit?: typeof withActionAdmission;
} = {}) =>
  createSafeRootHandler(
    config,
    async function* (ctx) {
      // A client that showed the models list's labels where the model was
      // chosen may name a model outside the region, or one whose provider
      // keeps the audio when the member is granted such models. Any other
      // request gets the region's models only.
      const labelsShown =
        ctx.body[TRANSCRIPTION_LABELS_SHOWN_FIELD] !== undefined;
      const result = yield* Result.await(
        executeDictation(
          labelsShown
            ? {
                ...ctx,
                allowOutsideRegion: true,
                allowRetainingModels: yield* Result.await(
                  readRetainingModelsGrant(ctx),
                ),
              }
            : ctx,
          {
            transcribe,
            transcribeElevenLabs,
            deployment,
            credential,
            limit,
            preflight,
            settle,
          },
        ),
      );
      return Result.ok(result);
    },
    admit === undefined ? undefined : { admit },
  );

const transcribeDictation = createDictationTranscribeEndpoint();

declareAggregateMutation(transcribeDictation, {
  type: "independent",
  reason:
    "Transcribes transient audio and appends organization-scoped usage and audit events; it does not change matter or document aggregate state.",
});

export default transcribeDictation;
