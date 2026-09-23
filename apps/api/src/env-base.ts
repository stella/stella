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
import { resolveCorpusMemberLayout } from "@/api/lib/legal-search/corpus-member-layout";

export { DEPLOYED_NODE_ENVS } from "@/api/env-base-schema";

const nodeEnv = process.env.NODE_ENV;
const nodeEnvKind = classifyNodeEnv(nodeEnv);
// An unset NODE_ENV classifies as local, so only a set value can be unknown.
if (nodeEnv !== undefined && nodeEnvKind === NODE_ENV_KIND.unknown) {
  panic(
    `NODE_ENV="${nodeEnv}" is not a recognized environment. Set one of ${KNOWN_NODE_ENVS.join(", ")}, or leave it unset for local development.`,
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

/**
 * How an ingestion batch lays its corpus payloads out. Unset keeps the
 * single-object layout every deployment runs today.
 */
export const corpusMemberLayout = resolveCorpusMemberLayout(
  envBase.CORPUS_MEMBER_LAYOUT,
);
