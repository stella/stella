import { createEnv } from "@t3-oss/env-core";
import * as v from "valibot";

export const env = createEnv({
  server: {
    STELLA_API_URL: v.pipe(v.string(), v.url()),
    STELLA_COLLAB_PORT: v.optional(
      v.pipe(
        v.string(),
        v.digits(),
        v.transform(Number),
        v.integer(),
        v.minValue(1),
        v.maxValue(65_535),
      ),
      "3002",
    ),
  },
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
});
