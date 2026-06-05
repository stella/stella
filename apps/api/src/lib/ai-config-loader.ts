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
import { decryptAIConfig } from "@/api/lib/ai-config-crypto";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";

const decodeNullableByteaText = (value: string | null | undefined) => {
  if (!value) {
    return null;
  }
  const hex = value.startsWith("\\x") ? value.slice(2) : value;
  return Buffer.from(hex, "hex");
};

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
  const row = rows.at(0);
  const ciphertext = decodeNullableByteaText(row?.aiConfigEncrypted);
  const iv = decodeNullableByteaText(row?.aiConfigIv);

  if (!ciphertext || !iv) {
    return null;
  }

  try {
    return await decryptAIConfig(organizationId, ciphertext, iv);
  } catch (error) {
    captureError(error, {
      organizationId,
      source: "loadOrgAIConfig",
    });
    return null;
  }
};

export const loadPromptCachingPreference = async (
  organizationId: SafeId<"organization">,
): Promise<boolean> => {
  const rows = await rootDb
    .select({ promptCachingEnabled: organizationSettings.promptCachingEnabled })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  const row = rows.at(0);
  return row?.promptCachingEnabled ?? true;
};
