import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";

import { envWebClientSchema } from "@/env-schema";

export const env = createEnv({
  clientPrefix: "VITE_",
  client: envWebClientSchema,
  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
});

if (env.VITE_PUBLIC_LAW_INDEXING_ENABLED && !env.VITE_PUBLIC_LAW_ENABLED) {
  panic("VITE_PUBLIC_LAW_INDEXING_ENABLED requires VITE_PUBLIC_LAW_ENABLED.");
}
