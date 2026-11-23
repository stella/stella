import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";

import { envPublicCorpusServerSchema } from "@/api/env-public-corpus-schema";
import { resolveConfigurationPlaceholders } from "@/api/lib/configuration-placeholders";

// Validates only the public corpus policy settings, so the public reader loads
// with database configuration alone. The API validates the same variables
// again through env.ts, which its entrypoint imports.
const publicCorpusRuntimeEnv = resolveConfigurationPlaceholders({
  schema: envPublicCorpusServerSchema,
  values: process.env,
});
if (publicCorpusRuntimeEnv.violation !== null) {
  panic(publicCorpusRuntimeEnv.violation);
}

export const envPublicCorpus = createEnv({
  server: envPublicCorpusServerSchema,
  emptyStringAsUndefined: true,
  runtimeEnv: publicCorpusRuntimeEnv.runtimeEnv,
});
