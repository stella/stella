import { createEnv } from "@t3-oss/env-core";

import { envCollabServerSchema } from "./env-schema";

export const env = createEnv({
  server: envCollabServerSchema,
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
});
