import { rootDb } from "@/api/db/root";
import {
  type CaseLawConfigReadTransaction,
  readCourtWeightRowsQuery,
  readFtsConfigRowsQuery,
} from "@/api/lib/case-law/case-law-config-read";
import {
  type CourtWeightCache,
  type CourtWeightMap,
  createCourtWeightCache,
} from "@/api/lib/case-law/court-weights";
import {
  createFtsConfigCache,
  type FtsConfig,
  type FtsConfigCache,
} from "@/api/lib/legal-search/fts-config";

/**
 * The search configuration of the local corpus, read on the service's own
 * connection. The indexers build search documents with these configurations
 * and maintenance ranks the local citation graph with this registry, so both
 * have to come from the database they write. Public search paths read
 * `public-case-law-config.ts` instead; each keeps its own cache.
 */
type LocalCaseLawConfig = {
  courtWeights: CourtWeightCache;
  ftsConfigs: FtsConfigCache;
};

const localCaseLawConfigOver = (
  db: CaseLawConfigReadTransaction,
): LocalCaseLawConfig => ({
  courtWeights: createCourtWeightCache(
    async () => await readCourtWeightRowsQuery(db),
  ),
  ftsConfigs: createFtsConfigCache(
    async () => await readFtsConfigRowsQuery(db),
  ),
});

let instance: LocalCaseLawConfig | null = null;

const localCaseLawConfig = (): LocalCaseLawConfig =>
  (instance ??= localCaseLawConfigOver(rootDb));

/** The local corpus's court registry, cached for 60 s. */
export const loadLocalCourtWeights = async (): Promise<CourtWeightMap> =>
  await localCaseLawConfig().courtWeights.load();

/** Resolve regconfig + unaccent for a language code the indexer writes. */
export const resolveLocalFtsConfig = async (
  language: string | null | undefined,
): Promise<FtsConfig> =>
  await localCaseLawConfig().ftsConfigs.resolveFtsConfig(language);

/**
 * Drop the cached configuration. With `db`, the next read goes through that
 * handle instead of the service's connection, so a test can hold the local
 * source apart from the public one.
 */
export const resetLocalCaseLawConfigForTesting = (
  db?: CaseLawConfigReadTransaction,
): void => {
  instance = db === undefined ? null : localCaseLawConfigOver(db);
};
