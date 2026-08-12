// Passive regression fixture for `confine-redis-client/confine-redis-client`.
//
// This file is deliberately absent from the rule's `allowedFiles` allowlist in
// oxlint.config.ts, so every reference to the Valkey connection module here
// must be rejected.

// oxlint-disable-next-line confine-redis-client/confine-redis-client -- fixture proves a static import outside the allowlist is rejected
import { createRedisClient } from "@/api/lib/redis-client";
// oxlint-disable-next-line confine-redis-client/confine-redis-client -- fixture proves a type-only import still opens the module surface and is rejected
import type { createBullMqConnection } from "@/api/lib/redis-client";

const loadConnection = async () =>
  // oxlint-disable-next-line confine-redis-client/confine-redis-client -- fixture proves a dynamic import is rejected
  await import("@/api/lib/redis-client");

void loadConnection;
void createRedisClient;
type _Connection = typeof createBullMqConnection;
