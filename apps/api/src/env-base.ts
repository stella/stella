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
import { panic } from "better-result";
import * as v from "valibot";

import { resolveDatabaseUrl } from "@/api/db-url";

/**
 * NODE_ENV values that identify a deployed (non-local) Stella
 * environment. Used to gate strict env validation and the
 * `isDev` default below. Kept here so every entrypoint that
 * imports `envBase` sees the same definition.
 */
export const DEPLOYED_NODE_ENVS = new Set(["production", "staging"]);

const databasePoolMaxSchema = v.optional(
  v.pipe(
    v.string(),
    v.digits(),
    v.transform(Number),
    v.integer(),
    v.minValue(1),
  ),
  "5",
);

export const envBase = createEnv({
  server: {
    DATABASE_URL: v.pipe(v.string(), v.url()),
    DATABASE_ROOT_POOL_MAX: databasePoolMaxSchema,
    DATABASE_RLS_POOL_MAX: databasePoolMaxSchema,
    S3_ENDPOINT: v.string(),
    S3_BUCKET: v.string(),
    S3_CREDENTIALS_PROVIDER: v.optional(
      v.picklist(["auto", "env", "aws-runtime", "none"]),
      "auto",
    ),
    S3_ACCESS_KEY_ID: v.optional(v.string()),
    S3_SECRET_ACCESS_KEY: v.optional(v.string()),
    S3_REGION: v.string(),
    S3_SCOPED_SIGNING_ROLE_ARN: v.optional(v.string()),
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
    // Legal corpus + Quickwit. Defaults keep the shipped pg-fts /
    // Postgres-text path active; flipping to Quickwit is a config change.
    LEGAL_SEARCH_PROVIDER: v.optional(
      v.picklist(["pg-fts", "quickwit"]),
      "pg-fts",
    ),
    // Blue-green generation prefix. Each jurisdiction gets its own index
    // (`<generation>_<country>`, e.g. case_law_v1_svk); bump the prefix to
    // rebuild all jurisdictions and flip to it.
    LEGAL_SEARCH_INDEX_GENERATION: v.optional(v.string(), "case_law_v1"),
    QUICKWIT_ENDPOINT: v.optional(v.pipe(v.string(), v.url())),
    QUICKWIT_S3_BUCKET: v.optional(v.string()),
    // Falls back to S3_BUCKET when unset (dev). Required when
    // CORPUS_STORAGE_ENABLED is true (enforced post-validation).
    LEGAL_CORPUS_S3_BUCKET: v.optional(v.string()),
    CORPUS_STORAGE_ENABLED: v.optional(
      v.pipe(v.string(), v.parseBoolean()),
      "false",
    ),
    QUICKWIT_INDEXING_ENABLED: v.optional(
      v.pipe(v.string(), v.parseBoolean()),
      "false",
    ),
    isDev: v.optional(
      v.boolean(),
      !DEPLOYED_NODE_ENVS.has(process.env.NODE_ENV ?? ""),
    ),
  },
  emptyStringAsUndefined: true,
  runtimeEnv: { ...process.env, DATABASE_URL: resolveDatabaseUrl() },
});

// Cross-field invariants the per-field schema can't express.
if (
  envBase.LEGAL_SEARCH_PROVIDER === "quickwit" &&
  envBase.QUICKWIT_ENDPOINT === undefined
) {
  panic("LEGAL_SEARCH_PROVIDER=quickwit requires QUICKWIT_ENDPOINT to be set");
}

// In deployed envs the corpus must use its own bucket, not the default
// document bucket (it falls back to S3_BUCKET only for local dev).
if (
  envBase.CORPUS_STORAGE_ENABLED &&
  !envBase.isDev &&
  envBase.LEGAL_CORPUS_S3_BUCKET === undefined
) {
  panic(
    "CORPUS_STORAGE_ENABLED requires LEGAL_CORPUS_S3_BUCKET in deployed environments",
  );
}
