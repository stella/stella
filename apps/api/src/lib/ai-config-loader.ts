/**
 * Loader for organization AI configuration.
 *
 * Every loader reads through the handle its caller passes: a request's scoped
 * transaction (the `organization_settings` policy admits the caller's own
 * organization), a worker's database, or the authentication boundary's
 * connection before any request scope exists. The lookup is a single indexed
 * select on organization_id, so a request can fold it into a transaction it
 * already holds, and the BYOK key material is decrypted in process.
 */

import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { organizationSettings } from "@/api/db/schema";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { decryptAIConfig } from "@/api/lib/ai-config-crypto";
import {
  decryptOrgAIConfigRow,
  decryptOrgAIConfigRowOrThrow,
  ORG_AI_CONFIG_STATUS,
  resolvePromptCachingPreference,
} from "@/api/lib/ai-config-loader-core";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import {
  memberAssignmentRequiredError,
  ownAIKeyRequiredError,
} from "@/api/lib/ai-config-response";
import type { SafeId } from "@/api/lib/branded-types";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
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

const selectAISettingsRow = async (
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
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1)
    .then((rows) => rows.at(0));

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

/**
 * For callers that are about to use the config for an AI call. Throws a
 * typed `ConfigurationError` on a corrupt stored row (see
 * `decryptOrgAIConfigRowOrThrow`) rather than silently falling back to no
 * config, which could mis-route or mis-bill. An org barred from the instance
 * provider without a config of its own is an error result.
 */
export const loadOrgAIConfig = async (
  db: OrgSettingsReader,
  reader: OrgAIConfigReader,
): Promise<Result<OrgAIConfig | null, HandlerError<403>>> => {
  const { organizationId } = reader;
  const rows = await db
    .select({
      aiConfigEncrypted: sql<
        string | null
      >`${organizationSettings.aiConfigEncrypted}::text`,
      aiConfigIv: sql<string | null>`${organizationSettings.aiConfigIv}::text`,
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  const orgAIConfig = await decryptOrgAIConfigRowOrThrow({
    decrypt: decryptAIConfig,
    organizationId,
    row: rows.at(0),
  });
  return await requireAIAccessAllowed(db, reader, orgAIConfig);
};

export type OrgAISettings = {
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
};

/**
 * {@link loadOrgAIConfig} plus the organization's prompt-caching preference in
 * one select, for AI call sites that need both. Keeps the strict corruption
 * semantics of {@link loadOrgAIConfig}: a stored row that does not decrypt
 * throws instead of degrading to platform defaults.
 */
export const loadOrgAISettings = async (
  db: OrgSettingsReader,
  reader: OrgAIConfigReader,
): Promise<Result<OrgAISettings, HandlerError<403>>> => {
  const { organizationId } = reader;
  const row = await selectAISettingsRow(db, organizationId);
  const orgAIConfig = await decryptOrgAIConfigRowOrThrow({
    decrypt: decryptAIConfig,
    organizationId,
    row,
  });
  const allowed = await requireAIAccessAllowed(db, reader, orgAIConfig);
  return allowed.map((config) => ({
    orgAIConfig: config,
    promptCachingEnabled: resolvePromptCachingPreference(row),
  }));
};

export type OrgSettingsForAuth = {
  orgAIConfig: OrgAIConfig | null;
  orgAIConfigStatus: OrgAIConfigStatus;
  promptCachingEnabled: boolean;
};

/**
 * The AI config and prompt-caching preference for callers (the validateAuth
 * resolve, the MCP capability context) that need both on every request, in a
 * single `organization_settings` select.
 *
 * Deliberately degrades a corrupt stored config to `orgAIConfig: null`
 * instead of throwing: this backs the shared per-request auth resolve, so a
 * single undecryptable row (key rotation, cross-env restore) must not fail
 * every request for the org. The decrypt failure is still captured (see
 * `decryptOrgAIConfigRow`) and reported as `orgAIConfigStatus:
 * "unreadable"`, which AI-invoking call sites must fail closed on rather
 * than reading the null as "this org has no config of its own". An org
 * whose access state bars the instance provider reports `own_key_required`,
 * and a member it does not admit to AI work `member_assignment_required`, the
 * same way, so non-AI requests keep working.
 */
export const loadOrgSettingsForAuth = async (
  db: OrgSettingsReader,
  { organizationId, userId }: OrgAIConfigReader,
): Promise<OrgSettingsForAuth> => {
  const row = await selectAISettingsRow(db, organizationId);

  const decryptResult = await decryptOrgAIConfigRow({
    decrypt: decryptAIConfig,
    organizationId,
    row,
  });
  const promptCachingEnabled = resolvePromptCachingPreference(row);
  if (decryptResult.status === "corrupt") {
    return {
      orgAIConfig: null,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.unreadable,
      promptCachingEnabled,
    };
  }

  const orgAIConfig = decryptResult.config;
  if (!(await memberMayUseAI(db, organizationId, userId))) {
    return {
      orgAIConfig,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.memberAssignmentRequired,
      promptCachingEnabled,
    };
  }
  const orgAIConfigStatus =
    orgAIConfig === null && !(await mayUseInstanceModels(db, organizationId))
      ? ORG_AI_CONFIG_STATUS.ownKeyRequired
      : ORG_AI_CONFIG_STATUS.ok;
  return { orgAIConfig, orgAIConfigStatus, promptCachingEnabled };
};
