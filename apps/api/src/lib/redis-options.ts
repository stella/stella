/**
 * Per-driver Redis connection options.
 *
 * The Valkey/Redis instance lives in a private VPC subnet
 * reachable only from API tasks via the security group, but is
 * served over TLS (`rediss://`) per the encryption-in-transit
 * rule. The cert is self-signed and bound to the ENI IP, so
 * client-side cert verification has no useful trust anchor —
 * `rejectUnauthorized: false` skips the chain check while still
 * negotiating an encrypted channel. The SG keeps the surface
 * small enough that a MITM would already be inside the VPC.
 */

import type { RedisOptions } from "bun";

import { env } from "@/api/env";

export const redisConnectionOptions = (): RedisOptions => {
  const useTls = env.REDIS_URL.toLowerCase().startsWith("rediss://");
  return useTls ? { tls: { rejectUnauthorized: false } } : {};
};
