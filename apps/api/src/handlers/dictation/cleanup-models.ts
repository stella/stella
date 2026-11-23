import { Result } from "better-result";

import {
  type DesktopDictationCleanupModels,
  desktopDictationCleanupModelsSchema,
} from "@stll/api-contract/desktop-dictation-cleanup";
import type { DesktopFeatureId } from "@stll/api-contract/desktop-feature-access";

import { safeDbFromScoped } from "@/api/db/safe-db";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { loadOrgSettingsForAuth } from "@/api/lib/ai-config-loader";
import { orgAIConfigStatusError } from "@/api/lib/ai-config-response";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { getConfiguredChatModelOptions } from "@/api/lib/chat-model-selection";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import { isModelSelectionAvailableForTask } from "@/api/lib/tanstack-ai-models";

/**
 * The models a speaker may choose for dictation cleanup besides automatic
 * (the organization's fast model). They are the chat model picker's own
 * options, the models this organization's providers offer, kept to those the
 * cleanup task can run on: one list, so the desktop never names a model the
 * web app would not, and the server checks every chosen model against it.
 */

const REQUIRED_FEATURE_ID = "desktop-dictation" satisfies DesktopFeatureId;
/** The task a dictation cleanup runs; a chosen model must serve it. */
const CLEANUP_TASK = "short-text";

export const listDictationCleanupModels = (
  orgAIConfig: OrgAIConfig | null,
): DesktopDictationCleanupModels => ({
  models: getConfiguredChatModelOptions(orgAIConfig)
    .filter(({ provider, modelId }) =>
      isModelSelectionAvailableForTask({
        dataClass: "customer",
        provider,
        modelId,
        orgAIConfig,
        task: CLEANUP_TASK,
      }),
    )
    .map(({ value, displayName, provider }) => ({
      value,
      displayName,
      provider,
    })),
});

/**
 * The model a cleanup runs on: the speaker's choice while the organization
 * still offers it, otherwise `undefined`, which is automatic. A choice the
 * organization no longer offers (a provider key removed, a model dropped from
 * the catalog, another account) never refuses the dictation.
 */
export const resolveDictationCleanupModel = (
  model: string | undefined,
  orgAIConfig: OrgAIConfig | null,
): string | undefined =>
  model !== undefined &&
  listDictationCleanupModels(orgAIConfig).models.some(
    ({ value }) => value === model,
  )
    ? model
    : undefined;

type DesktopDictationCleanupModelsOptions = {
  authorizeAccount?: typeof authorizeDesktopAccount;
  loadSettings?: typeof loadOrgSettingsForAuth;
};

/**
 * Lists the cleanup models for a linked desktop whose member may dictate and
 * use AI. The answer carries model names only, never key material.
 */
export const createDesktopDictationCleanupModelsEndpoint = ({
  authorizeAccount = authorizeDesktopAccount,
  loadSettings = loadOrgSettingsForAuth,
}: DesktopDictationCleanupModelsOptions = {}) =>
  createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      response: safePublicHandlerResponseSchemasWithStatusText(
        desktopDictationCleanupModelsSchema,
      ),
    },
    async function* ({ request }) {
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
            message: "Dictation is unavailable",
          }),
        );
      }
      if (!hasMemberPermission(account.memberRole, { chat: ["create"] })) {
        return Result.err(
          new HandlerError({ status: 403, message: "AI use is not permitted" }),
        );
      }
      const settings = yield* Result.await(
        safeDbFromScoped(account.scopedDb)(
          async (tx) =>
            await loadSettings(tx, {
              organizationId: account.organizationId,
              userId: account.userId,
            }),
        ),
      );
      const configurationError = orgAIConfigStatusError(
        settings.orgAIConfigStatus,
      );
      if (configurationError !== null) {
        return Result.err(configurationError);
      }
      return Result.ok(listDictationCleanupModels(settings.orgAIConfig));
    },
  );

export const readDesktopDictationCleanupModels =
  createDesktopDictationCleanupModelsEndpoint();
