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

import { rootDb } from "@/api/db/root";
import { decryptAIConfig } from "@/api/lib/ai-config-crypto";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";

export const loadOrgAIConfig = async (
  organizationId: SafeId<"organization">,
): Promise<OrgAIConfig | null> => {
  const row = await rootDb.query.organizationSettings.findFirst({
    where: { organizationId: { eq: organizationId } },
    columns: {
      aiConfigEncrypted: true,
      aiConfigIv: true,
    },
  });

  if (!row?.aiConfigEncrypted || !row.aiConfigIv) {
    return null;
  }

  try {
    return await decryptAIConfig(
      organizationId,
      row.aiConfigEncrypted,
      row.aiConfigIv,
    );
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
  const row = await rootDb.query.organizationSettings.findFirst({
    where: { organizationId: { eq: organizationId } },
    columns: { promptCachingEnabled: true },
  });
  return row?.promptCachingEnabled ?? true;
};
