import { createEnv } from "@t3-oss/env-core";
import * as v from "valibot";

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    VITE_POSTHOG_KEY: v.optional(v.string()),
    VITE_POSTHOG_HOST: v.optional(v.string()),
    VITE_API_URL: v.pipe(v.string(), v.url()),
    VITE_RIVET_ENDPOINT: v.pipe(v.string(), v.url()),
    VITE_RIVET_NAMESPACE: v.string(),
  },

  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
});
