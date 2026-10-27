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
  storedAIConfigUnreadableError,
} from "@/api/lib/ai-config-response";
import type { SafeId } from "@/api/lib/branded-types";
import { DEFAULT_MANAGED_AI_RESIDENCY } from "@/api/lib/chat/ai-data-policy";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { withAggregateSavepoint } from "@/api/lib/db/aggregate-lock";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  authorizeOperation,
  snapshotOperationInput,
} from "@/api/lib/proofs/checked-transaction";
import type { CheckedOperationContext } from "@/api/lib/proofs/checked-transaction";
import { memberMayUseAI } from "@/api/lib/usage/member-capacity";
import { mayUseInstanceModels } from "@/api/lib/usage/organization-access-state";

const AI_SETTINGS_READ_FAILURE = failureSink({
  event: "ai.settings_read.failed",
  expected: [],
});

/** The one capability needed to query organization settings. */
export type OrgSettingsReader = Pick<Transaction, "select">;

/** Runtime settings reads isolate SQL failures from the caller's transaction. */
type RecoverableOrgSettingsReader = OrgSettingsReader & {
  transaction: <T>(run: (tx: OrgSettingsReader) => Promise<T>) => Promise<T>;
};

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
  db: RecoverableOrgSettingsReader,
  organizationId: SafeId<"organization">,
) => {
  // PostgreSQL aborts the current transaction on a failed statement. Catch
  // outside the nested transaction so its rollback restores the caller first.
  const result = await Result.tryPromise(async () =>
    withAggregateSavepoint(
      db,
      async (tx) => await queryAISettingsRow(tx, organizationId),
    ),
  );
  if (Result.isOk(result)) {
    return { type: "ready", row: result.value } as const;
  }
  observeFailure(result.error, {
    sink: AI_SETTINGS_READ_FAILURE,
    ctx: { organizationId },
  });
  return { type: "unavailable" } as const;
};

type ReadProviderConfigOptions = {
  organizationId: SafeId<"organization">;
  settings: Extract<
    Awaited<ReturnType<typeof selectAISettingsRow>>,
    { type: "ready" }
  >;
};

const readProviderConfig = async ({
  organizationId,
  settings,
}: ReadProviderConfigOptions) => {
  const decrypted = await decryptOrgAIConfigRow({
    decrypt: decryptAIConfig,
    organizationId,
    row: settings.row,
  });
  const resolution = resolveAIProviderSettings({
    orgConfigured: decrypted.status === "ok" && decrypted.config !== null,
    providerConfiguration: "allowed",
    readStatus: "ready",
  });
  return resolution.type === "orgSettings" && decrypted.status === "ok"
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
 * instance-provider fallback only when privacy preferences were read. Failed
 * settings reads refuse AI work rather than guessing caching or residency.
 */
export const loadOrgAIConfig = async (
  db: RecoverableOrgSettingsReader,
  reader: OrgAIConfigReader,
): Promise<Result<OrgAIConfig | null, HandlerError<403 | 503>>> => {
  const checkedReader = snapshotOperationInput(reader);
  const { organizationId } = checkedReader;
  const settings = await selectAISettingsRow(db, organizationId);
  if (settings.type === "unavailable") {
    return Result.err(storedAIConfigUnreadableError(undefined));
  }
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
 * one select. An absent row uses platform defaults; a failed read refuses AI
 * work because neither privacy preference is known.
 */
export const loadOrgAISettings = async (
  db: RecoverableOrgSettingsReader,
  reader: OrgAIConfigReader,
): Promise<Result<OrgAISettings, HandlerError<403 | 503>>> => {
  const checkedReader = snapshotOperationInput(reader);
  const { organizationId } = checkedReader;
  const settings = await selectAISettingsRow(db, organizationId);
  if (settings.type === "unavailable") {
    return Result.err(storedAIConfigUnreadableError(undefined));
  }
  const { row } = settings;
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

export type OrgSettingsForAuth =
  | {
      orgAIConfig: OrgAIConfig | null;
      orgAIConfigStatus: Exclude<OrgAIConfigStatus, "unreadable">;
      promptCachingEnabled: boolean;
      managedAIResidency: ManagedAIResidency;
    }
  | {
      orgAIConfig: null;
      orgAIConfigStatus: "unreadable";
      promptCachingEnabled: null;
      managedAIResidency: null;
    };

/**
 * The AI config and prompt-caching preference for callers (the validateAuth
 * resolve, the MCP capability context) that need both on every request, in a
 * single `organization_settings` select.
 *
 * Failed reads retain an unavailable outcome without inventing privacy
 * preferences. Non-AI operations can continue; AI admission rejects that state.
 */
export const loadOrgSettingsForAuth = async (
  db: RecoverableOrgSettingsReader,
  { organizationId, userId }: OrgAIConfigReader,
): Promise<OrgSettingsForAuth> => {
  const settings = await selectAISettingsRow(db, organizationId);
  if (settings.type === "unavailable") {
    return {
      orgAIConfig: null,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.unreadable,
      promptCachingEnabled: null,
      managedAIResidency: null,
    };
  }
  const { row } = settings;
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
