import { createEnv } from "@t3-oss/env-core";

import { envBaseServerSchema } from "./env-base-schema";

// Migration and repair entrypoints need only database timeout settings.
export const envDbTimeouts = createEnv({
  server: {
    DATABASE_POOL_IDLE_TIMEOUT_S:
      envBaseServerSchema.DATABASE_POOL_IDLE_TIMEOUT_S,
    DATABASE_STATEMENT_TIMEOUT_MS:
      envBaseServerSchema.DATABASE_STATEMENT_TIMEOUT_MS,
  },
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
});
