import { createEnv } from "@t3-oss/env-core";

import { envBaseServerSchema } from "./env-base-schema";

/** Database-only entrypoints do not require the API's object-storage settings. */
export const envDbLoadGate = createEnv({
  server: {
    DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER:
      envBaseServerSchema.DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER,
    DB_LOAD_GATE_EBS_SIGNAL: envBaseServerSchema.DB_LOAD_GATE_EBS_SIGNAL,
  },
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
});
