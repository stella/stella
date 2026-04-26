/**
 * TTL-cached loader for organization AI configuration.
 *
 * Used by both the authMacro (HTTP handlers) and actors
 * that run without a connection (workflow self-scheduling).
 * Config changes rarely; a 5-minute stale window is fine.
 */

import { db } from "@/api/db/root";
import { decryptAIConfig } from "@/api/lib/ai-config-crypto";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";

const TTL_MS = 5 * 60 * 1000;

type CachedEntry = {
  config: OrgAIConfig | null;
  expiresAt: number;
};

const cache = new Map<SafeId<"organization">, CachedEntry>();

export const loadOrgAIConfig = async (
  organizationId: SafeId<"organization">,
): Promise<OrgAIConfig | null> => {
  const cached = cache.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.config;
  }

  const row = await db.query.organizationSettings.findFirst({
    where: { organizationId: { eq: organizationId } },
    columns: {
      aiConfigEncrypted: true,
      aiConfigIv: true,
    },
  });

  let config: OrgAIConfig | null = null;
  if (row?.aiConfigEncrypted && row.aiConfigIv) {
    try {
      config = await decryptAIConfig(
        organizationId,
        row.aiConfigEncrypted,
        row.aiConfigIv,
      );
    } catch (error) {
      captureError(error, {
        organizationId,
        source: "loadOrgAIConfig",
      });
    }
  }

  cache.set(organizationId, {
    config,
    expiresAt: Date.now() + TTL_MS,
  });

  return config;
};

/** Remove a cached entry so the next load fetches fresh. */
export const invalidateOrgAIConfig = (
  organizationId: SafeId<"organization">,
): void => {
  cache.delete(organizationId);
};
