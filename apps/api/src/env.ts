import "dotenv/config";

import { createEnv } from "@t3-oss/env-core";
import * as v from "valibot";

const HTTPS_PROTOCOL = "https:";
const REDISS_PROTOCOL = "rediss:";

export const env = createEnv({
  server: {
    DATABASE_URL: v.pipe(v.string(), v.url()),
    S3_ENDPOINT: v.string(),
    S3_BUCKET: v.string(),
    S3_ACCESS_KEY_ID: v.string(),
    S3_SECRET_ACCESS_KEY: v.string(),
    S3_REGION: v.string(),
    POSTHOG_KEY: v.string(),
    POSTHOG_HOST: v.string(),
    GOOGLE_GENERATIVE_AI_API_KEY: v.string(),
    OPENROUTER_API_KEY: v.optional(v.string()),
    isDev: v.optional(v.boolean(), process.env.NODE_ENV !== "production"),
    USE_MOCK_AI: v.optional(v.picklist(["true", "false"]), "false"),
    BETTER_AUTH_SECRET: v.pipe(v.string(), v.minLength(32)),
    BETTER_AUTH_URL: v.pipe(v.string(), v.url()),
    RESEND_API_KEY: v.string(),
    TRANSACTIONAL_EMAIL_FROM: v.string(),
    FRONTEND_URL: v.pipe(v.string(), v.url()),
    REDIS_URL: v.pipe(
      v.string(),
      v.url(),
      v.check(
        (url) =>
          process.env.NODE_ENV !== "production" ||
          new URL(url).protocol === REDISS_PROTOCOL,
        "REDIS_URL must use rediss:// (TLS) in production",
      ),
    ),
    GOTENBERG_URL: v.pipe(
      v.string(),
      v.url(),
      v.check(
        (url) =>
          process.env.NODE_ENV !== "production" ||
          new URL(url).protocol === HTTPS_PROTOCOL,
        "GOTENBERG_URL must use HTTPS in production",
      ),
    ),
    GOTENBERG_USERNAME: v.string(),
    GOTENBERG_PASSWORD: v.string(),
    SEARCH_PROVIDER: v.optional(v.picklist(["pg-fts", "paradedb"]), "pg-fts"),
    CONTENT_ENCRYPTION_KEY: v.optional(
      v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/i)),
    ),
  },
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
});

// Prevent accidental mutation of env vars at runtime.
// Must run AFTER createEnv has consumed process.env.
if (process.env.NODE_ENV === "production") {
  Object.freeze(process.env);
}
