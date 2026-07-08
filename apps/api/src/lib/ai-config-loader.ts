/**
 * Loader for organization AI configuration.
 *
 * Used by the authMacro (HTTP handlers) and actors that run
 * without a connection (workflow self-scheduling). Reads from
 * the database on every call. The lookup is a single indexed
 * findFirst on organization_id and the BYOK key material is
 * decrypted in process; the cost is dominated by the network
 * round-trip to RDS, well under a millisecond inside the VPC.
 */

import { eq, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { organizationSettings } from "@/api/db/schema";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { decryptAIConfig } from "@/api/lib/ai-config-crypto";
import {
  decryptOrgAIConfigRow,
  resolvePromptCachingPreference,
} from "@/api/lib/ai-config-loader-core";
import type { SafeId } from "@/api/lib/branded-types";

export const loadOrgAIConfig = async (
  organizationId: SafeId<"organization">,
): Promise<OrgAIConfig | null> => {
  const rows = await rootDb
    .select({
      aiConfigEncrypted: sql<
        string | null
      >`${organizationSettings.aiConfigEncrypted}::text`,
      aiConfigIv: sql<string | null>`${organizationSettings.aiConfigIv}::text`,
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  return await decryptOrgAIConfigRow({
    decrypt: decryptAIConfig,
    organizationId,
    row: rows.at(0),
  });
};

export const loadPromptCachingPreference = async (
  organizationId: SafeId<"organization">,
): Promise<boolean> => {
  const rows = await rootDb
    .select({ promptCachingEnabled: organizationSettings.promptCachingEnabled })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  return resolvePromptCachingPreference(rows.at(0));
};

export type OrgSettingsForAuth = {
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
};

/**
 * Combined form of {@link loadOrgAIConfig} + {@link loadPromptCachingPreference}
 * for callers (the validateAuth resolve) that need both on every request.
 * A single `organization_settings` select instead of two halves the
 * per-request query floor for that hot path.
 */
export const loadOrgSettingsForAuth = async (
  organizationId: SafeId<"organization">,
): Promise<OrgSettingsForAuth> => {
  const rows = await rootDb
    .select({
      aiConfigEncrypted: sql<
        string | null
      >`${organizationSettings.aiConfigEncrypted}::text`,
      aiConfigIv: sql<string | null>`${organizationSettings.aiConfigIv}::text`,
      promptCachingEnabled: organizationSettings.promptCachingEnabled,
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  const row = rows.at(0);

  const orgAIConfig = await decryptOrgAIConfigRow({
    decrypt: decryptAIConfig,
    organizationId,
    row,
  });
  const promptCachingEnabled = resolvePromptCachingPreference(row);

  return { orgAIConfig, promptCachingEnabled };
};
