/**
 * Loader for organization AI configuration.
 *
 * Every loader reads through the handle its caller passes: a request's scoped
 * transaction (the `organization_settings` policy admits the caller's own
 * organization), a worker's database, or the authentication boundary's
 * connection before any request scope exists. Settings use an indexed select
 * on organization_id; the authorization step separately proves current
 * membership (and any applicable seat assignment) before a caller receives
 * decrypted BYOK material.
 */

import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";

import { resolveAIProviderSettings } from "@stll/api-contract/organization-ai-availability";

import type { Transaction } from "@/api/db/root";
import { organizationSettings } from "@/api/db/schema";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { decryptAIConfig } from "@/api/lib/ai-config-crypto";
import {
  decryptOrgAIConfigRow,
  ORG_AI_CONFIG_STATUS,
  resolvePromptCachingPreference,
} from "@/api/lib/ai-config-loader-core";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import {
  memberAssignmentRequiredError,
  ownAIKeyRequiredError,
} from "@/api/lib/ai-config-response";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { DEFAULT_MANAGED_AI_RESIDENCY } from "@/api/lib/chat/ai-data-policy";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import {
  authorizeOperation,
  snapshotOperationInput,
} from "@/api/lib/proofs/checked-transaction";
import type { CheckedOperationContext } from "@/api/lib/proofs/checked-transaction";
import { memberMayUseAI } from "@/api/lib/usage/member-capacity";
import { mayUseInstanceModels } from "@/api/lib/usage/organization-access-state";

/** The one capability the loaders need: a single `organization_settings` select. */
export type OrgSettingsReader = Pick<Transaction, "select">;

/**
 * Whose AI work the config is loaded for: the organization, and the member
 * the work runs as (the requester, or the actor that queued a run).
 */
export type OrgAIConfigReader = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const queryAISettingsRow = async (
  db: OrgSettingsReader,
  organizationId: SafeId<"organization">,
) =>
  await db
    .select({
      aiConfigEncrypted: sql<
        string | null
      >`${organizationSettings.aiConfigEncrypted}::text`,
      aiConfigIv: sql<string | null>`${organizationSettings.aiConfigIv}::text`,
      promptCachingEnabled: organizationSettings.promptCachingEnabled,
      managedAIResidency: organizationSettings.managedAIResidency,
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1)
    .then((rows) => rows.at(0));

const selectAISettingsRow = async (
  db: OrgSettingsReader,
  organizationId: SafeId<"organization">,
) => {
  const result = await Result.tryPromise(() =>
    queryAISettingsRow(db, organizationId),
  );
  if (Result.isOk(result)) {
    return { type: "ready", row: result.value } as const;
  }
  captureError(
    result.error,
    handlerErrorContext("aiConfig.read", { organizationId }),
  );
  return { type: "unavailable" } as const;
};

type ReadProviderConfigOptions = {
  organizationId: SafeId<"organization">;
  settings: Awaited<ReturnType<typeof selectAISettingsRow>>;
};

const readProviderConfig = async ({
  organizationId,
  settings,
}: ReadProviderConfigOptions) => {
  const decrypted =
    settings.type === "ready"
      ? await decryptOrgAIConfigRow({
          decrypt: decryptAIConfig,
          organizationId,
          row: settings.row,
        })
      : null;
  const resolution = resolveAIProviderSettings({
    orgConfigured: decrypted?.status === "ok" && decrypted.config !== null,
    providerConfiguration: "allowed",
    readStatus: decrypted?.status === "ok" ? "ready" : "unavailable",
  });
  return resolution.type === "orgSettings" && decrypted?.status === "ok"
    ? decrypted.config
    : null;
};

/**
 * Refuses a member the organization does not admit to AI work, whichever key
 * would serve it. A null config means "run on the instance provider"; refuses
 * when the org's access state bars that, as a deployment without instance
 * keys would.
 */
const requireAIAccessAllowed = async (
  db: OrgSettingsReader,
  { organizationId, userId }: OrgAIConfigReader,
  orgAIConfig: OrgAIConfig | null,
): Promise<Result<OrgAIConfig | null, HandlerError<403>>> => {
  if (!(await memberMayUseAI(db, organizationId, userId))) {
    return Result.err(memberAssignmentRequiredError());
  }
  if (
    orgAIConfig === null &&
    !(await mayUseInstanceModels(db, organizationId))
  ) {
    return Result.err(ownAIKeyRequiredError());
  }
  return Result.ok(orgAIConfig);
};

const AI_CONFIGURATION_ALLOWED = "AIConfigurationAllowed";

type AIConfigurationInput<Settings> = {
  actor: OrgAIConfigReader;
  settings: Settings;
};

export const readCheckedAIConfiguration = <Settings, N>({
  proof,
}: CheckedOperationContext<
  typeof AI_CONFIGURATION_ALLOWED,
  AIConfigurationInput<Settings>,
  N
>): Settings => proof.input.value.settings;

type ReadAIConfigurationOptions<Settings> = {
  db: OrgSettingsReader;
  reader: OrgAIConfigReader;
  orgAIConfig: OrgAIConfig | null;
  settings: Settings;
};

const readAIConfiguration = async <Settings>({
  db,
  reader,
  orgAIConfig,
  settings,
}: ReadAIConfigurationOptions<Settings>): Promise<
  Result<Settings, HandlerError<403>>
> => {
  const actor = {
    organizationId: reader.organizationId,
    userId: reader.userId,
  };
  const authorization = await authorizeOperation({
    kind: AI_CONFIGURATION_ALLOWED,
    input: { actor, settings },
    check: async ({ actor: checkedActor }) =>
      (await requireAIAccessAllowed(db, checkedActor, orgAIConfig)).map(
        () => undefined,
      ),
  });
  if (Result.isError(authorization)) {
    return Result.err(authorization.error);
  }
  return Result.ok(
    await authorization.value.execute((operation) =>
      readCheckedAIConfiguration(operation),
    ),
  );
};

/**
 * For callers that are about to use the config for an AI call. Uses the
 * default-provider fallback when stored settings cannot be read. An org barred
 * from the instance provider without a config of its own is an error result.
 */
export const loadOrgAIConfig = async (
  db: OrgSettingsReader,
  reader: OrgAIConfigReader,
): Promise<Result<OrgAIConfig | null, HandlerError<403>>> => {
  const checkedReader = snapshotOperationInput(reader);
  const { organizationId } = checkedReader;
  const settings = await selectAISettingsRow(db, organizationId);
  const orgAIConfig = await readProviderConfig({ organizationId, settings });
  return await readAIConfiguration({
    db,
    reader: checkedReader,
    orgAIConfig,
    settings: orgAIConfig,
  });
};

export const loadManagedAIResidency = async (
  db: OrgSettingsReader,
  organizationId: SafeId<"organization">,
): Promise<ManagedAIResidency> => {
  const rows = await db
    .select({ managedAIResidency: organizationSettings.managedAIResidency })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  return rows.at(0)?.managedAIResidency ?? DEFAULT_MANAGED_AI_RESIDENCY;
};

export type OrgAISettings = {
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  managedAIResidency: ManagedAIResidency;
};

/**
 * {@link loadOrgAIConfig} plus the organization's prompt-caching preference in
 * one select, for AI call sites that need both. Unreadable provider settings
 * use platform defaults, with the same member and organization access checks.
 */
export const loadOrgAISettings = async (
  db: OrgSettingsReader,
  reader: OrgAIConfigReader,
): Promise<Result<OrgAISettings, HandlerError<403>>> => {
  const checkedReader = snapshotOperationInput(reader);
  const { organizationId } = checkedReader;
  const settings = await selectAISettingsRow(db, organizationId);
  const row = settings.type === "ready" ? settings.row : undefined;
  const orgAIConfig = await readProviderConfig({ organizationId, settings });
  return await readAIConfiguration({
    db,
    reader: checkedReader,
    orgAIConfig,
    settings: {
      orgAIConfig,
      promptCachingEnabled: resolvePromptCachingPreference(row),
      managedAIResidency:
        row?.managedAIResidency ?? DEFAULT_MANAGED_AI_RESIDENCY,
    },
  });
};

export type OrgSettingsForAuth = {
  orgAIConfig: OrgAIConfig | null;
  orgAIConfigStatus: OrgAIConfigStatus;
  promptCachingEnabled: boolean;
  managedAIResidency: ManagedAIResidency;
};

/**
 * The AI config and prompt-caching preference for callers (the validateAuth
 * resolve, the MCP capability context) that need both on every request, in a
 * single `organization_settings` select.
 *
 * Unreadable settings use the shared default-provider decision. Seat and
 * organization access checks still run before the default can serve AI work.
 */
export const loadOrgSettingsForAuth = async (
  db: OrgSettingsReader,
  { organizationId, userId }: OrgAIConfigReader,
): Promise<OrgSettingsForAuth> => {
  const settings = await selectAISettingsRow(db, organizationId);
  const row = settings.type === "ready" ? settings.row : undefined;
  const orgAIConfig = await readProviderConfig({ organizationId, settings });
  const promptCachingEnabled = resolvePromptCachingPreference(row);
  const managedAIResidency =
    row?.managedAIResidency ?? DEFAULT_MANAGED_AI_RESIDENCY;
  if (!(await memberMayUseAI(db, organizationId, userId))) {
    return {
      orgAIConfig,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.memberAssignmentRequired,
      promptCachingEnabled,
      managedAIResidency,
    };
  }
  const orgAIConfigStatus =
    orgAIConfig === null && !(await mayUseInstanceModels(db, organizationId))
      ? ORG_AI_CONFIG_STATUS.ownKeyRequired
      : ORG_AI_CONFIG_STATUS.ok;
  return {
    orgAIConfig,
    orgAIConfigStatus,
    promptCachingEnabled,
    managedAIResidency,
  };
};
