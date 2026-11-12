import { Result } from "better-result";

import {
  defaultTranscriptionModelId,
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
} from "@stll/ai-catalog/transcription";
import { AI_FAILURE_CODES } from "@stll/api-contract";
import {
  type DesktopDictationModels,
  desktopDictationModelsSchema,
  desktopDictationTranscriptSchema,
  MAX_DESKTOP_DICTATION_TRANSCRIPT_LENGTH,
} from "@stll/api-contract/desktop-dictation-transcription";
import type { DesktopFeatureId } from "@stll/api-contract/desktop-feature-access";
import { MAX_TRANSCRIPTION_MULTIPART_BYTES } from "@stll/api-contract/transcription";
import { classifyFailure } from "@stll/errors";

import { safeDbFromScoped } from "@/api/db/safe-db";
import { desktopDictationBodySchema } from "@/api/handlers/dictation/schema";
import {
  DEFAULT_DICTATION_DEPENDENCIES,
  type DictationCaller,
  type DictationDependencies,
  executeDictation,
} from "@/api/handlers/dictation/transcribe";
import {
  loadOrgSettingsForAuth,
  type OrgSettingsForAuth,
} from "@/api/lib/ai-config-loader";
import { orgAIConfigStatusError } from "@/api/lib/ai-config-response";
import {
  ACCOUNT_ACCESS,
  admitFiniteAction,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { resolveCredentialMemberAuthorization } from "@/api/lib/auth";
import { checkRestrictedAccountOperation } from "@/api/lib/auth/review-account";
import type { SafeId } from "@/api/lib/branded-types";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { withActionAdmission } from "@/api/lib/rate-limit/action-admission";

// Its own invitation: dictation alone keeps speech on the computer, and only
// this decision lets a linked desktop send audio. The registry makes
// `desktop-dictation` its prerequisite.
const REQUIRED_FEATURE_ID =
  "desktop-dictation-cloud" satisfies DesktopFeatureId;

/**
 * The transcription models stella AI offers this organization: only those
 * available in its region, and none when its own AI provider does not
 * transcribe. The default is the model a request without one gets.
 */
export const listDictationModels = ({
  orgAIConfig,
  managedAIResidency,
}: Pick<
  OrgSettingsForAuth,
  "orgAIConfig" | "managedAIResidency"
>): DesktopDictationModels => {
  const none = (unavailable: "region" | "provider") => ({
    models: [],
    defaultModelId: null,
    unavailable,
  });
  if (managedAIResidency === null) {
    return none("region");
  }
  // Transcription runs only on the managed provider or the organization's
  // own OpenRouter key, as the transcription endpoint requires.
  if (
    orgAIConfig !== null &&
    !orgAIConfig.providers.some(({ provider }) => provider === "openrouter")
  ) {
    return none("provider");
  }
  const models = Object.keys(TRANSCRIPTION_MODELS)
    .filter(isTranscriptionModelId)
    .filter(
      (modelId) =>
        TRANSCRIPTION_MODELS[modelId].residency[managedAIResidency].status ===
        "available",
    )
    .map((modelId) => ({
      id: modelId,
      displayName: TRANSCRIPTION_MODELS[modelId].displayName,
    }));
  if (models.length === 0) {
    return none("region");
  }
  return {
    models,
    defaultModelId: defaultTranscriptionModelId(managedAIResidency) ?? null,
    unavailable: null,
  };
};

type DesktopDictationOptions = {
  authorizeAccount?: typeof authorizeDesktopAccount;
  loadSettings?: typeof loadOrgSettingsForAuth;
};

/** The linked account's email, for the restricted-account check a session
 *  handler runs from its session. Null for an account that is gone. */
const readLinkedAccountEmail = async (lookup: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}): Promise<string | null> =>
  (await resolveCredentialMemberAuthorization(lookup))?.email ?? null;

/** The linked desktop's member, refused unless cloud dictation is enabled
 *  for it and its role may use AI, with the organization's AI settings. */
const authorizeDictation = async (
  request: Request,
  {
    authorizeAccount = authorizeDesktopAccount,
    loadSettings = loadOrgSettingsForAuth,
  }: DesktopDictationOptions,
) =>
  await Result.gen(async function* () {
    const account = yield* Result.await(authorizeAccount(request));
    if (
      !isFeatureEnabled(
        account.featureAccessSnapshot,
        REQUIRED_FEATURE_ID,
        account,
      )
    ) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Cloud dictation is unavailable",
        }),
      );
    }
    if (!hasMemberPermission(account.memberRole, { chat: ["create"] })) {
      return Result.err(
        new HandlerError({ status: 403, message: "AI use is not permitted" }),
      );
    }
    const safeDb = safeDbFromScoped(account.scopedDb);
    const settings = yield* Result.await(
      safeDb(
        async (tx) =>
          await loadSettings(tx, {
            organizationId: account.organizationId,
            userId: account.userId,
          }),
      ),
    );
    return Result.ok({ account, safeDb, settings });
  });

export const createDesktopDictationModelsEndpoint = (
  options: DesktopDictationOptions = {},
) =>
  createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      response: safePublicHandlerResponseSchemasWithStatusText(
        desktopDictationModelsSchema,
      ),
    },
    async function* ({ request }) {
      const { settings } = yield* Result.await(
        authorizeDictation(request, options),
      );
      const configurationError = orgAIConfigStatusError(
        settings.orgAIConfigStatus,
      );
      if (configurationError !== null) {
        return Result.err(configurationError);
      }
      return Result.ok(listDictationModels(settings));
    },
  );

type DesktopTranscribeOptions = DesktopDictationOptions & {
  dependencies?: Partial<DictationDependencies>;
  admit?: typeof withActionAdmission;
  readAccountEmail?: typeof readLinkedAccountEmail;
};

/**
 * The account checks the member transcription endpoint gets from
 * `ACCOUNT_ACCESS.standard`: a public handler has no session to run them on,
 * so the linked account's email is read and checked here. The sandbox demo
 * account may link a desktop, but it never transcribes audio.
 */
const admitStandardAccount = async (
  account: { organizationId: SafeId<"organization">; userId: SafeId<"user"> },
  readAccountEmail: typeof readLinkedAccountEmail,
) => {
  const email = await readAccountEmail({
    organizationId: account.organizationId,
    userId: account.userId,
  });
  if (email === null) {
    return Result.err(
      new HandlerError({
        status: 403,
        message: "Cloud dictation is unavailable",
      }),
    );
  }
  return checkRestrictedAccountOperation(email, ACCOUNT_ACCESS.standard);
};

/**
 * One audio chunk a linked desktop chose to send to stella AI, transcribed
 * the way the member transcription endpoint does (region, provider, usage
 * and limits included) and answered with its text only. Neither the audio
 * nor the text is stored.
 */
export const createDesktopDictationTranscribeEndpoint = ({
  dependencies = {},
  admit,
  readAccountEmail = readLinkedAccountEmail,
  ...options
}: DesktopTranscribeOptions = {}) =>
  declareAggregateMutation(
    createSafeBoundedPublicHandler(
      {
        contract: "patch",
        accountAccess: ACCOUNT_ACCESS.sandbox,
        mcp: { type: "internal", reason: "auth_plumbing" },
        cache: { kind: "none" },
        requestBodyMaxBytes: MAX_TRANSCRIPTION_MULTIPART_BYTES,
        body: desktopDictationBodySchema,
        response: safePublicHandlerResponseSchemasWithStatusText(
          desktopDictationTranscriptSchema,
        ),
      },
      async function* (ctx) {
        const { request, body } = ctx;
        const { account, safeDb, settings } = yield* Result.await(
          authorizeDictation(request, options),
        );
        yield* Result.await(admitStandardAccount(account, readAccountEmail));
        const user = { id: account.userId };
        const session = { activeOrganizationId: account.organizationId };
        const caller: DictationCaller = {
          ...settings,
          user,
          session,
          safeDb,
          recordAuditEvent: createAuditRecorder({
            organizationId: account.organizationId,
            userId: account.userId,
            workspaceId: null,
            request,
            server: null,
          }),
          // The desktop names no matter, so no matter is ever looked up.
          getWorkspaceAccess: async () =>
            await Promise.reject(
              classifyFailure(
                new HandlerError({
                  status: 500,
                  message: "A desktop dictation named no matter",
                }),
                "organization_state_unreadable",
              ),
            ),
        };
        return yield* admitFiniteAction({
          actionKind: "dictation.transcribe",
          ctx: {
            ...ctx,
            user,
            session,
            scopedDb: account.scopedDb,
            actionSignal: request.signal,
          },
          ...(admit ? { admit } : {}),
          async *handler({ modelAdmission }) {
            const result = yield* Result.await(
              executeDictation(
                { ...caller, body, request, modelAdmission },
                { ...DEFAULT_DICTATION_DEPENDENCIES, ...dependencies },
              ),
            );
            // One chunk is at most a minute of speech; a longer answer is
            // not a transcript of it.
            if (result.text.length > MAX_DESKTOP_DICTATION_TRANSCRIPT_LENGTH) {
              return Result.err(
                classifyFailure(
                  new HandlerError({
                    status: 502,
                    code: AI_FAILURE_CODES.output_invalid,
                    message:
                      "The transcription provider returned an invalid response.",
                    hint: "Retry the audio chunk or select another available transcription model.",
                    retryable: false,
                  }),
                  "model_output_invalid",
                ),
              );
            }
            return Result.ok({ text: result.text });
          },
        });
      },
    ),
    {
      type: "independent",
      reason:
        "Transcribes transient desktop audio and appends organization-scoped usage and audit events; it does not change matter or document aggregate state.",
    },
  );

export const readDesktopDictationModels =
  createDesktopDictationModelsEndpoint();
export const transcribeDesktopDictation =
  createDesktopDictationTranscribeEndpoint();
