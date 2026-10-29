import { Result } from "better-result";
import type * as v from "valibot";

import {
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
} from "@stll/ai-catalog/transcription";
import { AI_FAILURE_CODES } from "@stll/api-contract";
import {
  MAX_TRANSCRIPTION_AUDIO_SECONDS,
  MAX_TRANSCRIPTION_MULTIPART_BYTES,
} from "@stll/api-contract/transcription";
import { classifyFailure } from "@stll/errors";

import type { SafeDbError } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { consumeDictationLimit } from "@/api/handlers/dictation/limits";
import {
  transcribeAudio,
  TRANSCRIPTION_AUDIO_MEDIA_TYPES,
  transcriptionResultSchema,
} from "@/api/handlers/dictation/provider";
import type { TranscriptionResult } from "@/api/handlers/dictation/provider";
import { dictationBodySchema } from "@/api/handlers/dictation/schema";
import { orgAIConfigStatusError } from "@/api/lib/ai-config-response";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeRootHandler,
  safeHandlerResponseSchemas,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { MemberCaller } from "@/api/lib/auth/member-caller";
import type { SafeId } from "@/api/lib/branded-types";
import { getManagedOpenRouterCredential } from "@/api/lib/chat/openrouter-credential";
import { managedProviderUnavailable } from "@/api/lib/chat/provider-data-policy";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { emitTranscriptionDurationCappedMetric } from "@/api/lib/observability/request-metrics";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";
import { transcriptionUsageUnits } from "@/api/lib/usage/unit-model";
import {
  assertUsageAvailable,
  recordUsageEvent,
} from "@/api/lib/usage/usage-ledger";

const config = {
  contract: "patch",
  description:
    "Transcribe one audio chunk without storing the audio or transcript. Upload file, modelId, optional ISO 639-1 language, a JSON array of vocabulary terms, and an optional matterId. Available through REST multipart upload; generic JSON capability transports cannot upload audio.",
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

type UsageCaller = Pick<
  MemberCaller,
  "safeDb" | "session" | "user" | "recordAuditEvent" | "managedAIResidency"
>;
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
  if (
    !isTranscriptionModelId(result.modelId) ||
    caller.managedAIResidency === null
  ) {
    return Result.err(managedProviderUnavailable("openrouter"));
  }
  const units = transcriptionUsageUnits({
    modelId: result.modelId,
    residency: caller.managedAIResidency,
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
  credential: typeof getManagedOpenRouterCredential;
  limit: typeof consumeDictationLimit;
  preflight: typeof checkUsage;
  settle: typeof settleUsage;
};

type DictationContext = MemberCaller & {
  body: v.InferOutput<typeof dictationBodySchema>;
  request: Request;
  modelAdmission?: ModelDispatchAdmission;
};

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
      if (access === null || access.status === "deleting") {
        return Result.err(
          new HandlerError({
            status: 404,
            code: "not_found",
            message: "Matter not found",
          }),
        );
      }
    }
    const residency = ctx.managedAIResidency;
    if (
      residency === null ||
      TRANSCRIPTION_MODELS[body.modelId].residency[residency].status !==
        "available"
    ) {
      return Result.err(
        classifyFailure(
          new HandlerError({
            status: 503,
            code: "transcription_model_unavailable",
            message: "This transcription model is not available in your region",
            hint: "Choose a transcription model available in your region.",
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
    const isByok = ownKey !== undefined;
    const maximumDurationMs = MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000;
    const usageCaller = {
      safeDb: ctx.safeDb,
      session,
      user,
      recordAuditEvent: ctx.recordAuditEvent,
      managedAIResidency: residency,
    };
    yield* Result.await(
      dependencies.preflight({
        caller: usageCaller,
        isByok,
        required: transcriptionUsageUnits({
          modelId: body.modelId,
          residency,
          durationMs: maximumDurationMs,
          isByok,
        }).unitsConsumed,
      }),
    );
    const admission = configuredModelAdmission(ctx);
    const credential =
      ownKey === undefined
        ? yield* Result.await(dependencies.credential(admission.modelTier))
        : { apiKey: ownKey };
    const result = yield* Result.await(
      dependencies.transcribe({
        audio: body.file,
        modelId: body.modelId,
        language: body.language,
        vocabulary: body.vocabulary,
        apiKey: credential.apiKey,
        residency,
        scope: {
          admission,
          organizationId: session.activeOrganizationId,
          userId: user.id,
        },
        signal: ctx.request.signal,
      }),
    );
    if (result.durationMs > maximumDurationMs) {
      emitTranscriptionDurationCappedMetric(body.modelId);
    }
    yield* Result.await(
      dependencies.settle({
        caller: usageCaller,
        result: {
          modelId: result.modelId,
          durationMs: Math.min(result.durationMs, maximumDurationMs),
        },
        workspaceId,
        isByok,
      }),
    );
    return Result.ok(result);
  });

export const createDictationTranscribeEndpoint = ({
  transcribe = transcribeAudio,
  credential = getManagedOpenRouterCredential,
  limit = consumeDictationLimit,
  preflight = checkUsage,
  settle = settleUsage,
}: Partial<DictationDependencies> = {}) =>
  createSafeRootHandler(config, async function* (ctx) {
    const result = yield* Result.await(
      executeDictation(ctx, {
        transcribe,
        credential,
        limit,
        preflight,
        settle,
      }),
    );
    return Result.ok(result);
  });

const transcribeDictation = createDictationTranscribeEndpoint();

declareAggregateMutation(transcribeDictation, {
  type: "independent",
  reason:
    "Transcribes transient audio and appends organization-scoped usage and audit events; it does not change matter or document aggregate state.",
});

export default transcribeDictation;
