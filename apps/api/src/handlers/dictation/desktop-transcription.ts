import { Result } from "better-result";
import type { InferOk } from "better-result";

import {
  defaultTranscriptionModelId,
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
  transcriptionEndpointFor,
} from "@stll/ai-catalog/transcription";
import { AI_FAILURE_CODES } from "@stll/api-contract";
import {
  DESKTOP_DICTATION_MODELS_LABELED_QUERY,
  DESKTOP_DICTATION_MODELS_RETENTION_QUERY,
  type DesktopDictationModels,
  desktopDictationModelsSchema,
  desktopDictationTranscriptSchema,
  MAX_DESKTOP_DICTATION_TRANSCRIPT_LENGTH,
} from "@stll/api-contract/desktop-dictation-transcription";
import type { DesktopFeatureId } from "@stll/api-contract/desktop-feature-access";
import {
  MAX_TRANSCRIPTION_MULTIPART_BYTES,
  MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH,
  MAX_TRANSCRIPTION_VOCABULARY_TERMS,
} from "@stll/api-contract/transcription";
import { workspaceIsVisible } from "@stll/api-contract/workspace-status";
import { classifyFailure } from "@stll/errors";
import { sha256Hex } from "@stll/sha256/bun";

import { safeDbFromScoped } from "@/api/db/safe-db";
import { typedDictationText } from "@/api/handlers/dictation/cleanup-model";
import { VOCABULARY_STATUS } from "@/api/handlers/dictation/provider";
import { desktopDictationBodySchema } from "@/api/handlers/dictation/schema";
import {
  DEFAULT_DICTATION_DEPENDENCIES,
  type DictationCaller,
  type DictationDependencies,
  type DictationUsageKey,
  executeDictation,
  RETAINING_MODELS_FEATURE_ID,
} from "@/api/handlers/dictation/transcribe";
import {
  readTranscriptionDeployment,
  type TranscriptionDeployment,
  transcriptionRetainsData,
  transcriptionServed,
  transcriptionServedAnywhere,
} from "@/api/handlers/dictation/transcription-deployment";
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
import type { AccessibleWorkspace } from "@/api/lib/auth/accessible-workspace";
import { checkRestrictedAccountOperation } from "@/api/lib/auth/review-account";
import type { SafeId } from "@/api/lib/branded-types";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import { readVocabularyHandler } from "@/api/lib/workspaces/vocabulary/read";

// Its own invitation: dictation alone keeps speech on the computer, and only
// this decision lets a linked desktop send audio. The registry makes
// `desktop-dictation` its prerequisite.
const REQUIRED_FEATURE_ID =
  "desktop-dictation-cloud" satisfies DesktopFeatureId;

/**
 * The transcription models stella AI offers this organization, also when it
 * brings another AI provider of its own, and none when this deployment has
 * no transcription provider. A desktop that labels models
 * also gets the models its region does not serve, marked as leaving it,
 * after the regional ones; an older desktop reads only the regional ones,
 * without labels. The default is the model a request without one gets and
 * never leaves the region.
 */
export const listDictationModels = (
  {
    orgAIConfig,
    managedAIResidency,
  }: Pick<OrgSettingsForAuth, "orgAIConfig" | "managedAIResidency">,
  {
    labeled = false,
    retention = false,
    retainingModels = false,
    deployment = readTranscriptionDeployment(),
  }: {
    labeled?: boolean;
    /** The desktop warns about `retainsData`, so models whose provider
     *  keeps the audio may be listed, marked. */
    retention?: boolean;
    /** The member may use a model whose provider keeps the audio. */
    retainingModels?: boolean;
    deployment?: TranscriptionDeployment;
  } = {},
): DesktopDictationModels => {
  const none = (unavailable: "region" | "provider") => ({
    models: [],
    defaultModelId: null,
    unavailable,
  });
  if (managedAIResidency === null) {
    return none("region");
  }
  const served = transcriptionServed(deployment, orgAIConfig, {
    retainingData: labeled && retention && retainingModels,
  });
  const offered = Object.keys(TRANSCRIPTION_MODELS)
    .filter(isTranscriptionModelId)
    .flatMap((modelId) => {
      const endpoint = transcriptionEndpointFor(modelId, managedAIResidency, {
        outsideRegion: labeled,
        served,
      });
      return endpoint === undefined
        ? []
        : [{ modelId, outsideRegion: endpoint !== managedAIResidency }];
    });
  // The regional models first, then those outside the region.
  const models = [
    ...offered.filter(({ outsideRegion }) => !outsideRegion),
    ...offered.filter(({ outsideRegion }) => outsideRegion),
  ].map(({ modelId, outsideRegion }) => {
    const { displayName, provider } = TRANSCRIPTION_MODELS[modelId];
    if (!labeled) {
      return { id: modelId, displayName };
    }
    const takes = takesVocabulary(modelId);
    return retention
      ? {
          id: modelId,
          displayName,
          provider,
          outsideRegion,
          retainsData: transcriptionRetainsData(deployment, modelId),
          takesVocabulary: takes,
        }
      : {
          id: modelId,
          displayName,
          provider,
          outsideRegion,
          takesVocabulary: takes,
        };
  });
  if (models.length === 0) {
    // Nothing this deployment can transcribe with, or nothing in the region.
    return none(transcriptionServedAnywhere(served) ? "region" : "provider");
  }
  return {
    models,
    defaultModelId:
      defaultTranscriptionModelId(
        managedAIResidency,
        transcriptionServed(deployment, orgAIConfig, { asDefault: true }),
      ) ?? null,
    unavailable: null,
  };
};

type DesktopDictationOptions = {
  authorizeAccount?: typeof authorizeDesktopAccount;
  loadSettings?: typeof loadOrgSettingsForAuth;
  readDeployment?: typeof readTranscriptionDeployment;
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
    return Result.ok({
      account,
      safeDb,
      settings,
      retainingModels: isFeatureEnabled(
        account.featureAccessSnapshot,
        RETAINING_MODELS_FEATURE_ID,
        account,
      ),
    });
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
      const { settings, retainingModels } = yield* Result.await(
        authorizeDictation(request, options),
      );
      const configurationError = orgAIConfigStatusError(
        settings.orgAIConfigStatus,
      );
      if (configurationError !== null) {
        return Result.err(configurationError);
      }
      const { searchParams } = new URL(request.url);
      return Result.ok(
        listDictationModels(settings, {
          deployment: (options.readDeployment ?? readTranscriptionDeployment)(),
          labeled:
            searchParams.get(DESKTOP_DICTATION_MODELS_LABELED_QUERY) === "1",
          retention:
            searchParams.get(DESKTOP_DICTATION_MODELS_RETENTION_QUERY) === "1",
          retainingModels,
        }),
      );
    },
  );

/** A matter a recording is filed under, as the linked member sees it: its
 *  access for usage and audit, and the names its transcription should
 *  spell right. */
type DesktopMatter = {
  workspace: AccessibleWorkspace | null;
  vocabulary: readonly string[];
};

type DesktopAccount = InferOk<
  Awaited<ReturnType<typeof authorizeDesktopAccount>>
>;

/** The matter under the member's own access, so a matter they cannot see
 *  is not found, with the names, case numbers and parties it holds. */
const readDesktopMatter = async (
  account: DesktopAccount,
  matterId: SafeId<"workspace">,
): Promise<DesktopMatter> => {
  const workspace = await account.scopedDb(
    async (tx) =>
      (await tx.query.workspaces.findFirst({
        where: {
          id: { eq: matterId },
          organizationId: { eq: account.organizationId },
        },
        columns: { id: true, status: true },
      })) ?? null,
  );
  if (workspace === null || !workspaceIsVisible(workspace.status)) {
    return { workspace: null, vocabulary: [] };
  }
  const read = await readVocabularyHandler({
    scopedDb: account.scopedDb,
    workspaceId: matterId,
    organizationId: account.organizationId,
  });
  return {
    workspace,
    vocabulary: "candidates" in read ? matterTerms(read.candidates) : [],
  };
};

/** Terms as a transcription takes them: each once whatever its case, the
 *  first spelling kept, short enough for a hint, in order, at most the
 *  contract's number. */
const transcriptionTerms = (terms: Iterable<string>): string[] => {
  const kept = new Map<string, string>();
  for (const term of terms) {
    const trimmed = term.trim();
    const key = trimmed.toLocaleLowerCase();
    if (
      trimmed.length > 0 &&
      trimmed.length <= MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH &&
      !kept.has(key)
    ) {
      kept.set(key, trimmed);
    }
    if (kept.size === MAX_TRANSCRIPTION_VOCABULARY_TERMS) {
      break;
    }
  }
  return [...kept.values()];
};

/** The matter's vocabulary as a transcription takes it, the most telling
 *  first. */
export const matterTerms = (
  candidates: readonly { term: string }[],
): string[] => transcriptionTerms(candidates.map(({ term }) => term));

/** What one chunk's model is told to spell right: the speaker's own custom
 *  words first, then the matter's names, within the contract's limits. */
export const desktopChunkVocabulary = (
  own: readonly string[] | undefined,
  matter: readonly string[],
): string[] =>
  transcriptionTerms(own === undefined ? matter : [...own, ...matter]);

/** Vocabulary goes only to a model that reads it; another would refuse the
 *  request or ignore the terms. A request without a model gets none. */
export const takesVocabulary = (modelId: string | undefined): boolean =>
  modelId !== undefined &&
  isTranscriptionModelId(modelId) &&
  VOCABULARY_STATUS[TRANSCRIPTION_MODELS[modelId].vocabularyMechanism] ===
    "applied";

/**
 * A recording's piece is counted once however often the desktop sends it:
 * the key is the member, the piece's own id and its audio, so an id sent
 * again with other audio is a new piece and is counted.
 */
const desktopPieceUsageKey = async (
  userId: SafeId<"user">,
  pieceId: string,
  audio: Blob,
): Promise<DictationUsageKey> => {
  const digest = sha256Hex(new Uint8Array(await audio.arrayBuffer()));
  return {
    idempotencyKey: `desktop-dictation-piece:${userId}:${pieceId}:${digest}`,
    resourceId: pieceId,
  };
};

/** The chunk with its vocabulary, for a model that reads one; any other
 *  gets none, so a custom word never makes a chunk fail. */
const withVocabulary = <Body extends { modelId?: string | undefined }>(
  body: Body,
  vocabulary: readonly string[],
): Body & { vocabulary?: string[] } =>
  vocabulary.length > 0 && takesVocabulary(body.modelId)
    ? { ...body, vocabulary: [...vocabulary] }
    : body;

type DesktopTranscribeOptions = DesktopDictationOptions & {
  dependencies?: Partial<DictationDependencies>;
  admit?: typeof withActionAdmission;
  readAccountEmail?: typeof readLinkedAccountEmail;
  readMatter?: typeof readDesktopMatter;
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
 * nor the text is stored. A chunk of a recording filed under a matter names
 * it: the member must see the matter, its usage is the matter's, and a
 * model that takes vocabulary gets the matter's names and case numbers,
 * after the speaker's own custom words the chunk carries. Neither is
 * logged.
 */
export const createDesktopDictationTranscribeEndpoint = ({
  dependencies = {},
  admit,
  readAccountEmail = readLinkedAccountEmail,
  readMatter = readDesktopMatter,
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
        const { request } = ctx;
        const { pieceId, vocabulary: ownWords, ...body } = ctx.body;
        const { account, safeDb, settings, retainingModels } =
          yield* Result.await(authorizeDictation(request, options));
        yield* Result.await(admitStandardAccount(account, readAccountEmail));
        const { matterId } = body;
        const matter =
          matterId === undefined
            ? null
            : yield* Result.await(
                Result.tryPromise({
                  try: async () => await readMatter(account, matterId),
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
        const user = { id: account.userId };
        const session = { activeOrganizationId: account.organizationId };
        const caller: DictationCaller = {
          ...settings,
          // The desktop lists models outside the region only labeled as such.
          allowOutsideRegion: true,
          // The desktop lists a model whose provider keeps the audio only
          // with its warning, and only to a member granted such models.
          allowRetainingModels: retainingModels,
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
          // Only the matter read above is ever looked up.
          getWorkspaceAccess: async (workspaceId: SafeId<"workspace">) =>
            await Promise.resolve(
              matter?.workspace?.id === workspaceId ? matter.workspace : null,
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
                {
                  ...caller,
                  body: withVocabulary(
                    body,
                    desktopChunkVocabulary(
                      ownWords,
                      matter === null ? [] : matter.vocabulary,
                    ),
                  ),
                  request,
                  modelAdmission,
                  ...(pieceId === undefined
                    ? {}
                    : {
                        usageKey: await desktopPieceUsageKey(
                          account.userId,
                          pieceId,
                          body.file,
                        ),
                      }),
                },
                { ...DEFAULT_DICTATION_DEPENDENCIES, ...dependencies },
              ),
            );
            // The desktop types this text; the provider's answer is not
            // trusted to hold only typeable characters.
            const text = typedDictationText(result.text);
            // One chunk is at most a minute of speech; a longer answer is
            // not a transcript of it.
            if (text.length > MAX_DESKTOP_DICTATION_TRANSCRIPT_LENGTH) {
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
            return Result.ok({ text });
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
