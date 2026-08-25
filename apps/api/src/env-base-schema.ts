/**
 * Base environment variables shared by all entrypoints
 * (API server, ingestion scripts, CLI tools).
 *
 * API-specific variables (auth, email, gotenberg, etc.) live in env.ts;
 * document-processing settings live in env-document-processing-worker.ts.
 * Scripts that only need DB + S3 + observability should import
 * from here to avoid requiring the full API env.
 */
import * as v from "valibot";

import { hasSecureDatabaseTransport } from "@/api/db-url";
import {
  CORPUS_STORAGE_MODES,
  type CorpusStorageMode,
  corpusStorageInvariantViolation,
  resolveCorpusStorageMode,
} from "@/api/lib/corpus-storage-mode";
import { parseCorpusIndexClusterForGeneration } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  QUERY_EXPANSION_MODES,
  type QueryExpansionMode,
} from "@/api/lib/legal-search/query-expansion-mode";
import { isUsableStaticCredential } from "@/api/lib/s3-credentials";
import { isTlsOrLoopbackUrl } from "@/api/lib/secure-service-url";

/**
 * NODE_ENV values that identify a deployed (non-local) Stella
 * environment. Used to gate strict env validation and the
 * `isDev` default below. Kept here so every entrypoint that
 * imports `envBase` sees the same definition.
 */
export const DEPLOYED_NODE_ENVS = new Set(["production", "staging"]);

const databasePoolMaxValueSchema = v.pipe(
  v.string(),
  v.digits(),
  v.toNumber(),
  v.integer(),
  v.minValue(1),
);

const databasePoolMaxSchema = (fallback = "5") =>
  v.optional(databasePoolMaxValueSchema, fallback);

const documentOcrBatchIntervalMinutesSchema = v.optional(
  v.pipe(
    v.string(),
    v.digits(),
    v.toNumber(),
    v.integer(),
    v.minValue(5),
    v.maxValue(10_080),
  ),
  "1440",
);

// Connection-recycling bounds for the Bun SQL pools, in seconds.
// Bun never recycles connections by default (maxLifetime/idleTimeout both 0).
// Keep that default until the runtime retires only idle connections; current
// Bun timers can interrupt in-flight queries. Operators can opt in explicitly
// after upgrading the runtime. 0 disables a bound.
const databasePoolSecondsSchema = (fallback: string) =>
  v.optional(
    v.pipe(v.string(), v.digits(), v.toNumber(), v.integer()),
    fallback,
  );

const postgresUrlSchema = () =>
  v.pipe(
    v.string(),
    v.url(),
    v.check((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "postgres:" || protocol === "postgresql:";
    }, "must use postgres:// or postgresql://."),
  );

type BoundedIntegerEnvOptions = {
  fallback: string;
  min: number;
  max: number;
};

const boundedIntegerEnv = ({ fallback, min, max }: BoundedIntegerEnvOptions) =>
  v.optional(
    v.pipe(
      v.string(),
      v.digits(),
      v.toNumber(),
      v.integer(),
      v.minValue(min),
      v.maxValue(max),
    ),
    fallback,
  );

const BACKPRESSURE_DIMENSIONS_PATTERN =
  /^[^=,\s]+=[^=,]+(?:,[^=,\s]+=[^=,]+)*$/u;

const nonNegativeNumberEnv = (fallback: string) =>
  v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.toNumber(),
      v.finite(),
      v.minValue(0),
    ),
    fallback,
  );

export const envBaseServerSchema = {
  STELLA_VERSION: v.optional(v.string()),
  STELLA_COMMIT_SHA: v.optional(v.string()),
  STELLA_WORKER_DIR: v.optional(v.string()),
  STELLA_OCR_PDF_FONT_PATH: v.optional(v.string()),
  SKIP_MIGRATION_CHECK: v.optional(v.pipe(v.string(), v.parseBoolean())),
  INGESTION_USER_AGENT: v.optional(v.string()),
  DATABASE_URL: v.pipe(v.string(), v.url()),
  DATABASE_ROOT_POOL_MAX: databasePoolMaxSchema(),
  DATABASE_RLS_POOL_MAX: databasePoolMaxSchema(),
  PUBLIC_LAW_DATABASE_URL: v.optional(postgresUrlSchema()),
  PUBLIC_LAW_DATABASE_POOL_MAX: databasePoolMaxSchema("2"),
  // REMOVAL CONDITION: delete both CASE_LAW_* inputs after v0.7.22 is no
  // longer a deployable rollback target. All consumers use PUBLIC_LAW_*.
  CASE_LAW_DATABASE_URL: v.optional(postgresUrlSchema()),
  CASE_LAW_DATABASE_POOL_MAX: v.optional(databasePoolMaxValueSchema),
  DATABASE_POOL_MAX_LIFETIME_S: databasePoolSecondsSchema("0"),
  DATABASE_POOL_IDLE_TIMEOUT_S: databasePoolSecondsSchema("0"),
  DOCUMENT_OCR_BATCH_INTERVAL_MINUTES: documentOcrBatchIntervalMinutesSchema,
  S3_ENDPOINT: v.pipe(v.string(), v.url()),
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
  // OTLP log export is opt-in per deployment: absent means structured logs
  // stay local (stderr mirror only), so self-hosted installs never phone
  // home. The URL carries the full ingest path; the token authenticates it.
  LOGS_OTLP_URL: v.optional(v.pipe(v.string(), v.url())),
  LOGS_OTLP_TOKEN: v.optional(v.string()),
  POSTHOG_LOCAL_DEBUG: v.optional(
    v.pipe(v.string(), v.parseBoolean()),
    "false",
  ),
  // Legal corpus + corpus index. Defaults keep the shipped pg-fts /
  // Postgres-text path active; flipping to corpus index is a config change.
  LEGAL_SEARCH_PROVIDER: v.optional(
    v.picklist(["pg-fts", "corpus-index"]),
    "pg-fts",
  ),
  // Blue-green generation prefix. Each jurisdiction gets its own index
  // (`<generation>_<country>`, e.g. case_law_v1_svk) up to generation 2, and
  // each index group from generation 3 on (`corpusIndexId`); bump the prefix
  // to rebuild all jurisdictions and flip to it.
  LEGAL_SEARCH_INDEX_GENERATION: v.optional(v.string(), "case_law_v1"),
  // Local-development-only search endpoint for consuming a shared corpus.
  // Request-path searches use it while mutations remain bound to the separate
  // admin endpoint below, which shared-corpus mode requires to stay unset.
  CORPUS_INDEX_SEARCH_ENDPOINT: v.optional(v.pipe(v.string(), v.url())),
  CORPUS_INDEX_ENDPOINT: v.optional(v.pipe(v.string(), v.url())),
  CORPUS_INDEX_Q09_SEARCH_ENDPOINT: v.optional(v.pipe(v.string(), v.url())),
  CORPUS_INDEX_Q09_ENDPOINT: v.optional(v.pipe(v.string(), v.url())),
  CORPUS_INDEX_S3_BUCKET: v.optional(v.string()),
  // Falls back to S3_BUCKET when unset (dev). Required when corpus
  // storage is on (enforced post-validation).
  LEGAL_CORPUS_S3_BUCKET: v.optional(v.string()),
  // Where the canonical corpus payload lives. Unset derives the mode from
  // the legacy CORPUS_STORAGE_ENABLED boolean below.
  CORPUS_STORAGE_MODE: v.optional(v.picklist(CORPUS_STORAGE_MODES)),
  // Superseded by CORPUS_STORAGE_MODE; still accepted, and true still
  // means "dual-write". Read `corpusStorageMode`, never this field.
  CORPUS_STORAGE_ENABLED: v.optional(
    v.pipe(v.string(), v.parseBoolean()),
    "false",
  ),
  CORPUS_INDEXING_ENABLED: v.optional(
    v.pipe(v.string(), v.parseBoolean()),
    "false",
  ),
  // Corpus-index throughput. The defaults reproduce the loop's historical
  // pace exactly, so leaving these unset changes nothing; raising them is a
  // deployment decision made where it is visible and revertible without a
  // build. Bounds keep a typo from turning the loop into a stampede.
  CORPUS_INDEX_BATCH_SIZE: boundedIntegerEnv({
    fallback: "50",
    min: 1,
    max: 2000,
  }),
  CORPUS_INDEX_INTERVAL_MS: boundedIntegerEnv({
    fallback: "15000",
    min: 250,
    max: 300_000,
  }),
  CORPUS_INDEX_READ_CONCURRENCY: boundedIntegerEnv({
    fallback: "4",
    min: 1,
    max: 32,
  }),
  // Optional pacing for long-running corpus-index builds. When metric and
  // namespace are set, the build loop samples that CloudWatch metric and
  // pauses while the value is below the low watermark, resuming once it
  // climbs back above the high watermark. Unset means no pacing check.
  CORPUS_INDEX_BACKPRESSURE_METRIC: v.optional(
    v.pipe(v.string(), v.trim(), v.nonEmpty()),
  ),
  CORPUS_INDEX_BACKPRESSURE_NAMESPACE: v.optional(
    v.pipe(v.string(), v.trim(), v.nonEmpty()),
  ),
  // `Name=Value[,Name=Value...]` metric dimensions.
  CORPUS_INDEX_BACKPRESSURE_DIMENSIONS: v.optional(
    v.pipe(
      v.string(),
      v.regex(
        BACKPRESSURE_DIMENSIONS_PATTERN,
        "must be Name=Value[,Name=Value...]",
      ),
    ),
  ),
  CORPUS_INDEX_BACKPRESSURE_LOW_WATERMARK: nonNegativeNumberEnv("30"),
  CORPUS_INDEX_BACKPRESSURE_HIGH_WATERMARK: nonNegativeNumberEnv("50"),
  CORPUS_INDEX_BACKPRESSURE_SAMPLE_INTERVAL_MS: boundedIntegerEnv({
    fallback: "60000",
    min: 5000,
    max: 3_600_000,
  }),
  // Morphological query expansion for case-law corpus-index searches.
  // `off` is byte-identical to the pre-expansion query builder and fetches
  // no dictionary; `shadow` executes the unexpanded query and records how the
  // expanded one compares (leaf counts only, never query text). `on` executes
  // the expanded query and is refused at boot by the invariant below until
  // corpus cursors carry the dictionary version they were built against.
  QUERY_EXPANSION_MODE: v.optional(v.picklist(QUERY_EXPANSION_MODES), "off"),
  isDev: v.boolean(),
};

/** Alternative inputs accepted by resolveDatabaseUrl(). */
export const databaseComponentEnvSchema = {
  DB_HOST: v.optional(v.string()),
  DB_PORT: v.optional(v.pipe(v.string(), v.digits())),
  DB_USER: v.optional(v.string()),
  DB_PASSWORD: v.optional(v.string()),
  DB_NAME: v.optional(v.string()),
  DB_SSLMODE: v.optional(v.picklist(["require", "verify-ca", "verify-full"])),
};

type EnvBaseInvariantInput = {
  CASE_LAW_DATABASE_URL?: string | undefined;
  PUBLIC_LAW_DATABASE_URL?: string | undefined;
  CORPUS_INDEX_BACKPRESSURE_DIMENSIONS?: string | undefined;
  CORPUS_INDEX_BACKPRESSURE_HIGH_WATERMARK: number;
  CORPUS_INDEX_BACKPRESSURE_LOW_WATERMARK: number;
  CORPUS_INDEX_BACKPRESSURE_METRIC?: string | undefined;
  CORPUS_INDEX_BACKPRESSURE_NAMESPACE?: string | undefined;
  CORPUS_INDEX_ENDPOINT?: string | undefined;
  CORPUS_INDEX_Q09_ENDPOINT?: string | undefined;
  CORPUS_INDEX_Q09_SEARCH_ENDPOINT?: string | undefined;
  CORPUS_INDEX_SEARCH_ENDPOINT?: string | undefined;
  CORPUS_INDEXING_ENABLED: boolean;
  CORPUS_STORAGE_ENABLED: boolean;
  CORPUS_STORAGE_MODE?: CorpusStorageMode | undefined;
  DATABASE_URL: string;
  LEGAL_CORPUS_S3_BUCKET?: string | undefined;
  LEGAL_SEARCH_INDEX_GENERATION: string;
  LEGAL_SEARCH_PROVIDER: "pg-fts" | "corpus-index";
  QUERY_EXPANSION_MODE: QueryExpansionMode;
  S3_ACCESS_KEY_ID?: string | undefined;
  S3_CREDENTIALS_PROVIDER: "auto" | "env" | "aws-runtime" | "none";
  S3_ENDPOINT: string;
  S3_SECRET_ACCESS_KEY?: string | undefined;
  isDev: boolean;
};

export const envBaseInvariantViolation = ({
  CASE_LAW_DATABASE_URL,
  PUBLIC_LAW_DATABASE_URL,
  CORPUS_INDEX_BACKPRESSURE_DIMENSIONS,
  CORPUS_INDEX_BACKPRESSURE_HIGH_WATERMARK,
  CORPUS_INDEX_BACKPRESSURE_LOW_WATERMARK,
  CORPUS_INDEX_BACKPRESSURE_METRIC,
  CORPUS_INDEX_BACKPRESSURE_NAMESPACE,
  CORPUS_INDEX_ENDPOINT,
  CORPUS_INDEX_Q09_ENDPOINT,
  CORPUS_INDEX_Q09_SEARCH_ENDPOINT,
  CORPUS_INDEX_SEARCH_ENDPOINT,
  CORPUS_INDEXING_ENABLED,
  CORPUS_STORAGE_ENABLED,
  CORPUS_STORAGE_MODE,
  DATABASE_URL,
  LEGAL_CORPUS_S3_BUCKET,
  LEGAL_SEARCH_INDEX_GENERATION,
  LEGAL_SEARCH_PROVIDER,
  QUERY_EXPANSION_MODE,
  S3_ACCESS_KEY_ID,
  S3_CREDENTIALS_PROVIDER,
  S3_ENDPOINT,
  S3_SECRET_ACCESS_KEY,
  isDev,
}: EnvBaseInvariantInput): string | null => {
  const hasPublicLawDatabaseUrl =
    PUBLIC_LAW_DATABASE_URL !== undefined ||
    CASE_LAW_DATABASE_URL !== undefined;

  if (
    CASE_LAW_DATABASE_URL !== undefined &&
    PUBLIC_LAW_DATABASE_URL === undefined
  ) {
    return "CASE_LAW_DATABASE_URL is a v0.7.22 rollback input; configure PUBLIC_LAW_DATABASE_URL for the current release.";
  }
  if (
    (CORPUS_INDEX_BACKPRESSURE_METRIC === undefined) !==
    (CORPUS_INDEX_BACKPRESSURE_NAMESPACE === undefined)
  ) {
    return "CORPUS_INDEX_BACKPRESSURE_METRIC and CORPUS_INDEX_BACKPRESSURE_NAMESPACE must be set together.";
  }
  if (
    CORPUS_INDEX_BACKPRESSURE_DIMENSIONS !== undefined &&
    CORPUS_INDEX_BACKPRESSURE_METRIC === undefined
  ) {
    return "CORPUS_INDEX_BACKPRESSURE_DIMENSIONS requires CORPUS_INDEX_BACKPRESSURE_METRIC.";
  }
  if (
    CORPUS_INDEX_BACKPRESSURE_METRIC !== undefined &&
    CORPUS_INDEX_BACKPRESSURE_LOW_WATERMARK >=
      CORPUS_INDEX_BACKPRESSURE_HIGH_WATERMARK
  ) {
    return "CORPUS_INDEX_BACKPRESSURE_LOW_WATERMARK must be below CORPUS_INDEX_BACKPRESSURE_HIGH_WATERMARK.";
  }
  if (!isDev && !hasSecureDatabaseTransport(DATABASE_URL)) {
    return "DATABASE_URL must enable TLS outside loopback or Railway private networking.";
  }
  if (
    PUBLIC_LAW_DATABASE_URL !== undefined &&
    !hasSecureDatabaseTransport(PUBLIC_LAW_DATABASE_URL)
  ) {
    return "PUBLIC_LAW_DATABASE_URL must enable TLS outside loopback or Railway private networking.";
  }
  if (
    CASE_LAW_DATABASE_URL !== undefined &&
    !hasSecureDatabaseTransport(CASE_LAW_DATABASE_URL)
  ) {
    return "CASE_LAW_DATABASE_URL must enable TLS outside loopback or Railway private networking.";
  }
  if (!isDev && hasPublicLawDatabaseUrl) {
    return "Public-law database URLs are only supported in local development.";
  }
  if (
    CORPUS_INDEX_SEARCH_ENDPOINT !== undefined &&
    !isTlsOrLoopbackUrl(CORPUS_INDEX_SEARCH_ENDPOINT, {
      plaintextProtocol: "http:",
      tlsProtocol: "https:",
    })
  ) {
    return "CORPUS_INDEX_SEARCH_ENDPOINT must use HTTPS unless it targets a loopback address.";
  }
  if (!isDev && CORPUS_INDEX_SEARCH_ENDPOINT !== undefined) {
    return "CORPUS_INDEX_SEARCH_ENDPOINT is only supported in local development.";
  }
  if (
    CORPUS_INDEX_Q09_SEARCH_ENDPOINT !== undefined &&
    !isTlsOrLoopbackUrl(CORPUS_INDEX_Q09_SEARCH_ENDPOINT, {
      plaintextProtocol: "http:",
      tlsProtocol: "https:",
    })
  ) {
    return "CORPUS_INDEX_Q09_SEARCH_ENDPOINT must use HTTPS unless it targets a loopback address.";
  }
  if (!isDev && CORPUS_INDEX_Q09_SEARCH_ENDPOINT !== undefined) {
    return "CORPUS_INDEX_Q09_SEARCH_ENDPOINT is only supported in local development.";
  }
  // REMOVAL CONDITION: delete this invariant in the PR that makes a corpus
  // cursor carry the dictionary version it was built against.
  //
  // Under `on` the engine query depends on which dictionary the serving
  // replica loaded, so a page-2 request landing on a replica mid-refresh
  // rebuilds a different query and ranks a different result set against page
  // 1's cursor, skipping or repeating decisions. `shadow` cannot reach this,
  // because it executes the unexpanded query. Refusing the mode at boot is
  // what keeps the broken combination unreachable rather than merely
  // documented.
  if (QUERY_EXPANSION_MODE === "on") {
    return 'QUERY_EXPANSION_MODE="on" requires dictionary-version-carrying cursors; not yet implemented — use "shadow".';
  }
  if (hasPublicLawDatabaseUrl && LEGAL_SEARCH_PROVIDER !== "corpus-index") {
    return 'Public-law database URLs require LEGAL_SEARCH_PROVIDER="corpus-index".';
  }
  if (
    hasPublicLawDatabaseUrl &&
    CORPUS_INDEX_SEARCH_ENDPOINT === undefined &&
    CORPUS_INDEX_Q09_SEARCH_ENDPOINT === undefined
  ) {
    return "Public-law database URLs require CORPUS_INDEX_SEARCH_ENDPOINT or CORPUS_INDEX_Q09_SEARCH_ENDPOINT.";
  }
  if (
    hasPublicLawDatabaseUrl &&
    (CORPUS_INDEX_ENDPOINT !== undefined ||
      CORPUS_INDEX_Q09_ENDPOINT !== undefined)
  ) {
    return "CORPUS_INDEX_ENDPOINT and CORPUS_INDEX_Q09_ENDPOINT must be unset when a public-law database URL is configured.";
  }
  if (hasPublicLawDatabaseUrl && CORPUS_INDEXING_ENABLED) {
    return "CORPUS_INDEXING_ENABLED must be false when a public-law database URL is configured.";
  }
  if (
    !isDev &&
    !isTlsOrLoopbackUrl(S3_ENDPOINT, {
      plaintextProtocol: "http:",
      tlsProtocol: "https:",
    })
  ) {
    return "S3_ENDPOINT must use HTTPS unless it targets a loopback address.";
  }
  const hasAccessKey = isUsableStaticCredential(S3_ACCESS_KEY_ID);
  const hasSecretKey = isUsableStaticCredential(S3_SECRET_ACCESS_KEY);
  if (hasAccessKey !== hasSecretKey) {
    return "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together.";
  }
  if (S3_CREDENTIALS_PROVIDER === "env" && !(hasAccessKey && hasSecretKey)) {
    return 'S3_CREDENTIALS_PROVIDER="env" requires static S3 credentials.';
  }
  const caseLawCluster = parseCorpusIndexClusterForGeneration(
    "case_law",
    LEGAL_SEARCH_INDEX_GENERATION,
  );
  if (LEGAL_SEARCH_PROVIDER === "corpus-index" && caseLawCluster === null) {
    return `Unknown case-law corpus index generation: ${LEGAL_SEARCH_INDEX_GENERATION}.`;
  }
  if (
    LEGAL_SEARCH_PROVIDER === "corpus-index" &&
    CORPUS_INDEX_SEARCH_ENDPOINT === undefined &&
    CORPUS_INDEX_ENDPOINT === undefined
  ) {
    return "Serving legislation_v1 on q08 requires CORPUS_INDEX_SEARCH_ENDPOINT or CORPUS_INDEX_ENDPOINT.";
  }
  if (
    LEGAL_SEARCH_PROVIDER === "corpus-index" &&
    caseLawCluster === "q09" &&
    CORPUS_INDEX_Q09_SEARCH_ENDPOINT === undefined &&
    CORPUS_INDEX_Q09_ENDPOINT === undefined
  ) {
    return "Serving case_law_v5 on q09 requires CORPUS_INDEX_Q09_SEARCH_ENDPOINT or CORPUS_INDEX_Q09_ENDPOINT.";
  }

  return corpusStorageInvariantViolation({
    mode: resolveCorpusStorageMode({
      mode: CORPUS_STORAGE_MODE,
      legacyEnabled: CORPUS_STORAGE_ENABLED,
    }),
    searchProvider: LEGAL_SEARCH_PROVIDER,
    corpusIndexingEnabled: CORPUS_INDEXING_ENABLED,
    corpusBucket: LEGAL_CORPUS_S3_BUCKET,
    isDev,
  });
};
