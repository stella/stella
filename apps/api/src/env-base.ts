/**
 * Base environment variables shared by all entrypoints
 * (API server, ingestion scripts, CLI tools).
 *
 * API-specific variables (auth, email, gotenberg, redis, etc.)
 * live in env.ts and are only validated when the API server boots.
 * Scripts that only need DB + S3 + observability should import
 * from here to avoid requiring the full API env.
 */
import { createEnv } from "@t3-oss/env-core";
import * as v from "valibot";

export const envBase = createEnv({
  server: {
    DATABASE_URL: v.pipe(v.string(), v.url()),
    S3_ENDPOINT: v.string(),
    S3_BUCKET: v.string(),
    S3_CREDENTIALS_PROVIDER: v.optional(
      v.picklist(["auto", "env", "aws-runtime", "none"]),
      "auto",
    ),
    S3_ACCESS_KEY_ID: v.optional(v.string()),
    S3_SECRET_ACCESS_KEY: v.optional(v.string()),
    S3_REGION: v.string(),
    POSTHOG_KEY: v.optional(v.string()),
    POSTHOG_HOST: v.optional(v.string()),
    POSTHOG_LOCAL_DEBUG: v.optional(
      v.pipe(v.string(), v.parseBoolean()),
      "false",
    ),
    POSTHOG_LOCAL_DEBUG_AI_CONTENT: v.optional(
      v.pipe(v.string(), v.parseBoolean()),
      "false",
    ),
    isDev: v.optional(v.boolean(), process.env.NODE_ENV !== "production"),
  },
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
});
