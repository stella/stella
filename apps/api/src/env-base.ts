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
import { envBaseServerSchema } from "@/api/env-base-schema";
import {
  corpusStorageInvariantViolation,
  resolveCorpusStorageMode,
} from "@/api/lib/corpus-storage-mode";

export { DEPLOYED_NODE_ENVS } from "@/api/env-base-schema";

export const envBase = createEnv({
  server: envBaseServerSchema,
  emptyStringAsUndefined: true,
  runtimeEnv: { ...process.env, DATABASE_URL: resolveDatabaseUrl() },
});

if (
  envBase.LEGAL_SEARCH_PROVIDER === "corpus-index" &&
  envBase.CORPUS_INDEX_ENDPOINT === undefined
) {
  panic(
    "LEGAL_SEARCH_PROVIDER=corpus-index requires CORPUS_INDEX_ENDPOINT to be set",
  );
}

/**
 * The single corpus-storage value consumed across the codebase. Derived from
 * CORPUS_STORAGE_MODE, falling back to the legacy boolean.
 */
export const corpusStorageMode = resolveCorpusStorageMode({
  mode: envBase.CORPUS_STORAGE_MODE,
  legacyEnabled: envBase.CORPUS_STORAGE_ENABLED,
});

const corpusStorageViolation = corpusStorageInvariantViolation({
  mode: corpusStorageMode,
  searchProvider: envBase.LEGAL_SEARCH_PROVIDER,
  corpusIndexingEnabled: envBase.CORPUS_INDEXING_ENABLED,
  corpusBucket: envBase.LEGAL_CORPUS_S3_BUCKET,
  isDev: envBase.isDev,
});
if (corpusStorageViolation !== null) {
  panic(corpusStorageViolation);
}
