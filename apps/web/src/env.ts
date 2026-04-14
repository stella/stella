import { createEnv } from "@t3-oss/env-core";
import * as v from "valibot";

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    VITE_POSTHOG_KEY: v.optional(v.string()),
    VITE_POSTHOG_HOST: v.optional(v.string()),
    VITE_POSTHOG_LOCAL_DEBUG: v.optional(
      v.pipe(v.string(), v.parseBoolean()),
      "false",
    ),
    VITE_API_URL: v.pipe(v.string(), v.url()),
    VITE_DESKTOP_BRIDGE_PORT: v.optional(
      v.pipe(
        v.string(),
        v.digits(),
        v.transform(Number),
        v.integer(),
        v.minValue(1),
        v.maxValue(65_535),
      ),
      "45901",
    ),
    VITE_AUTH_GOOGLE: v.optional(v.pipe(v.string(), v.parseBoolean()), "false"),
    VITE_AUTH_MICROSOFT: v.optional(
      v.pipe(v.string(), v.parseBoolean()),
      "false",
    ),
  },

  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
});
