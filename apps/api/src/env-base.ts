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
  classifyNodeEnv,
  envBaseInvariantViolation,
  envBaseServerSchema,
  KNOWN_NODE_ENVS,
  NODE_ENV_KIND,
  resolveApiEnvironmentPlaceholders,
} from "@/api/env-base-schema";
import { resolveCorpusStorageMode } from "@/api/lib/corpus-storage-mode";

export { DEPLOYED_NODE_ENVS } from "@/api/env-base-schema";

const nodeEnvKind = classifyNodeEnv(process.env.NODE_ENV);
if (nodeEnvKind === NODE_ENV_KIND.unknown) {
  panic(
    `NODE_ENV="${process.env.NODE_ENV}" is not a recognized environment. Set one of ${KNOWN_NODE_ENVS.join(", ")}, or leave it unset for local development.`,
  );
}

const baseRuntimeEnv = resolveApiEnvironmentPlaceholders({
  schema: envBaseServerSchema,
  values: process.env,
});
if (baseRuntimeEnv.violation !== null) {
  panic(baseRuntimeEnv.violation);
}

export const envBase = createEnv({
  server: envBaseServerSchema,
  emptyStringAsUndefined: true,
  runtimeEnv: {
    ...baseRuntimeEnv.runtimeEnv,
    DATABASE_URL: resolveDatabaseUrl(baseRuntimeEnv.runtimeEnv),
    isDev: nodeEnvKind === NODE_ENV_KIND.local,
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
