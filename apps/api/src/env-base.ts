/**
 * Base environment variables shared by all entrypoints
 * (API server, ingestion scripts, CLI tools).
 *
 * API-specific variables (auth, email, gotenberg, etc.) live in env.ts;
 * document-processing settings live in env-document-processing-worker.ts.
 * Scripts that only need DB + S3 + observability should import from here to
 * avoid requiring the full API env.
 */
import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";

import { resolveDatabaseUrl } from "@/api/db-url";
import {
  DEPLOYED_NODE_ENVS,
  envBaseInvariantViolation,
  envBaseServerSchema,
  resolvePublicLawDatabaseEnvironment,
} from "@/api/env-base-schema";
import { resolveCorpusStorageMode } from "@/api/lib/corpus-storage-mode";

export { DEPLOYED_NODE_ENVS } from "@/api/env-base-schema";

const publicLawDatabaseEnvironment = resolvePublicLawDatabaseEnvironment({
  CASE_LAW_DATABASE_POOL_MAX: process.env.CASE_LAW_DATABASE_POOL_MAX,
  CASE_LAW_DATABASE_URL: process.env.CASE_LAW_DATABASE_URL,
  PUBLIC_LAW_DATABASE_POOL_MAX: process.env.PUBLIC_LAW_DATABASE_POOL_MAX,
  PUBLIC_LAW_DATABASE_URL: process.env.PUBLIC_LAW_DATABASE_URL,
});

export const envBase = createEnv({
  server: envBaseServerSchema,
  emptyStringAsUndefined: true,
  runtimeEnv: {
    ...process.env,
    ...publicLawDatabaseEnvironment,
    DATABASE_URL: resolveDatabaseUrl(),
    isDev: !DEPLOYED_NODE_ENVS.has(process.env.NODE_ENV ?? ""),
  },
});

const invariantViolation = envBaseInvariantViolation(envBase);
if (invariantViolation !== null) {
  panic(invariantViolation);
}

/**
 * The single corpus-storage value consumed across the codebase. Derived from
 * CORPUS_STORAGE_MODE, falling back to the legacy boolean.
 */
export const corpusStorageMode = resolveCorpusStorageMode({
  mode: envBase.CORPUS_STORAGE_MODE,
  legacyEnabled: envBase.CORPUS_STORAGE_ENABLED,
});
