import { createEnv } from "@t3-oss/env-core";

import { envBaseServerSchema } from "./env-base-schema";

/** The migrate entrypoint's own settings; it needs no other API configuration. */
export const envMigrate = createEnv({
  server: {
    STELLA_MIGRATE_ONLINE_WORK: envBaseServerSchema.STELLA_MIGRATE_ONLINE_WORK,
  },
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
});
