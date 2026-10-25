import { defaultKeyHasher } from "@better-auth/api-key";
import { generateRandomString } from "better-auth/crypto";
import { panic } from "better-result";

import { apikey } from "@/api/db/auth-schema";
import type { CreateApiKey } from "@/api/handlers/api-keys/mint";
import type { CredentialIssuanceFence } from "@/api/lib/auth-artifacts";
import {
  MACHINE_API_KEY_LENGTH,
  MACHINE_API_KEY_PREFIX,
  MACHINE_API_KEY_RATE_LIMIT,
  MACHINE_API_KEY_START_LENGTH,
} from "@/api/lib/machine-api-key-config";

/**
 * Inserts a key with the plugin's generator and hasher contract, inside the
 * transaction that holds the owner's credential fence. An access reset locks
 * the same fence and sweeps keys in its own transaction, so a key written here
 * either commits before the sweep, which revokes it, or finds its session gone.
 */
export const createApiKeyUnderFence =
  (fence: CredentialIssuanceFence, now: Date): CreateApiKey =>
  async ({ body }) => {
    if (body.userId !== fence.userId) {
      return panic("An API key is issued only to the fenced account");
    }
    const key = `${MACHINE_API_KEY_PREFIX}${generateRandomString(MACHINE_API_KEY_LENGTH, "a-z", "A-Z")}`;
    const id = Bun.randomUUIDv7();
    const start = key.slice(0, MACHINE_API_KEY_START_LENGTH);
    const expiresAt = new Date(now.getTime() + body.expiresIn * 1000);
    // audit: skip - every caller records the key's receipt in this fenced transaction
    await fence.tx.insert(apikey).values({
      id,
      configId: body.configId,
      referenceId: body.userId,
      name: body.name,
      prefix: MACHINE_API_KEY_PREFIX,
      start,
      key: await defaultKeyHasher(key),
      metadata: JSON.stringify(body.metadata),
      permissions: JSON.stringify(body.permissions),
      expiresAt,
      createdAt: now,
      updatedAt: now,
      enabled: true,
      rateLimitEnabled: MACHINE_API_KEY_RATE_LIMIT.enabled,
      rateLimitMax: MACHINE_API_KEY_RATE_LIMIT.maxRequests,
      rateLimitTimeWindow: MACHINE_API_KEY_RATE_LIMIT.timeWindow,
    });
    return { id, start, key, expiresAt };
  };
