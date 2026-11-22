import { envBaseServerSchema } from "@/api/env-base-schema";

/**
 * The public corpus policy's slice of the base schema: pool sizes, replica
 * count, latency estimates and budget overrides. A process that reads only the
 * public corpus loads the policy with these settings, without the API's or a
 * worker's. The API still validates every variable through env.ts at boot.
 */
export const envPublicCorpusServerSchema = {
  PUBLIC_LAW_DATABASE_URL: envBaseServerSchema.PUBLIC_LAW_DATABASE_URL,
  PUBLIC_LAW_DATABASE_POOL_MAX:
    envBaseServerSchema.PUBLIC_LAW_DATABASE_POOL_MAX,
  DATABASE_ROOT_POOL_MAX: envBaseServerSchema.DATABASE_ROOT_POOL_MAX,
  PUBLIC_CORPUS_RESERVED_CONNECTIONS:
    envBaseServerSchema.PUBLIC_CORPUS_RESERVED_CONNECTIONS,
  PUBLIC_CORPUS_ASSUMED_REPLICAS:
    envBaseServerSchema.PUBLIC_CORPUS_ASSUMED_REPLICAS,
  PUBLIC_CORPUS_SEARCH_P95_SECONDS:
    envBaseServerSchema.PUBLIC_CORPUS_SEARCH_P95_SECONDS,
  PUBLIC_CORPUS_AGGREGATE_P95_SECONDS:
    envBaseServerSchema.PUBLIC_CORPUS_AGGREGATE_P95_SECONDS,
  PUBLIC_CORPUS_SITEMAP_P95_SECONDS:
    envBaseServerSchema.PUBLIC_CORPUS_SITEMAP_P95_SECONDS,
  PUBLIC_CORPUS_SEARCH_ADDRESS_MAX:
    envBaseServerSchema.PUBLIC_CORPUS_SEARCH_ADDRESS_MAX,
  PUBLIC_CORPUS_SEARCH_GLOBAL_MAX:
    envBaseServerSchema.PUBLIC_CORPUS_SEARCH_GLOBAL_MAX,
  PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX:
    envBaseServerSchema.PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX,
  PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX:
    envBaseServerSchema.PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX,
};
