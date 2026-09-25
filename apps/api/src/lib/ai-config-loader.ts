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
import type { SafeId } from "@/api/lib/branded-types";

/** The one capability the loaders need: a single `organization_settings` select. */
export type OrgSettingsReader = Pick<Transaction, "select">;

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
 * For callers that are about to use the config for an AI call. Throws a
 * typed `ConfigurationError` on a corrupt stored row (see
 * `decryptOrgAIConfigRowOrThrow`) rather than silently falling back to no
 * config, which could mis-route or mis-bill.
 */
export const loadOrgAIConfig = async (
  db: OrgSettingsReader,
  organizationId: SafeId<"organization">,
): Promise<OrgAIConfig | null> => {
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
  return await decryptOrgAIConfigRowOrThrow({
    decrypt: decryptAIConfig,
    organizationId,
    row: rows.at(0),
  });
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
  organizationId: SafeId<"organization">,
): Promise<OrgAISettings> => {
  const row = await selectAISettingsRow(db, organizationId);
  const orgAIConfig = await decryptOrgAIConfigRowOrThrow({
    decrypt: decryptAIConfig,
    organizationId,
    row,
  });
  return {
    orgAIConfig,
    promptCachingEnabled: resolvePromptCachingPreference(row),
  };
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
 * than reading the null as "this org has no config of its own".
 */
export const loadOrgSettingsForAuth = async (
  db: OrgSettingsReader,
  organizationId: SafeId<"organization">,
): Promise<OrgSettingsForAuth> => {
  const row = await selectAISettingsRow(db, organizationId);

  const decryptResult = await decryptOrgAIConfigRow({
    decrypt: decryptAIConfig,
    organizationId,
    row,
  });
  const orgAIConfig =
    decryptResult.status === "ok" ? decryptResult.config : null;
  const orgAIConfigStatus =
    decryptResult.status === "ok"
      ? ORG_AI_CONFIG_STATUS.ok
      : ORG_AI_CONFIG_STATUS.unreadable;
  const promptCachingEnabled = resolvePromptCachingPreference(row);

  return { orgAIConfig, orgAIConfigStatus, promptCachingEnabled };
};
