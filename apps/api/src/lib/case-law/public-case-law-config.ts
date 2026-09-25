import {
  caseLawPublicReadDb,
  type CaseLawPublicReadDb,
} from "@/api/lib/case-law-public-read-db";
import {
  type CaseLawConfigReadTransaction,
  readCourtWeightRowsQuery,
  readFtsConfigRowsQuery,
} from "@/api/lib/case-law/case-law-config-read";
import {
  type CourtWeightCache,
  type CourtWeightEntry,
  type CourtWeightMap,
  createCourtWeightCache,
  type LoadCourtWeightsOptions,
} from "@/api/lib/case-law/court-weights";
import {
  createFtsConfigCache,
  type FtsConfigCache,
  type FtsSearchConfig,
} from "@/api/lib/legal-search/fts-config";

/**
 * The search configuration of the public corpus: the court registry and the
 * text-search configurations, read through the public-law reader from the
 * database the public search documents live in. Search paths read these; the
 * indexers and maintenance read `local-case-law-config.ts`, the database they
 * write. Each keeps its own cache, so neither answers from the other's rows.
 */
type PublicCaseLawConfig = {
  courtWeights: CourtWeightCache;
  ftsConfigs: FtsConfigCache;
};

const publicCaseLawConfigOver = (
  readDb: CaseLawPublicReadDb,
): PublicCaseLawConfig => ({
  courtWeights: createCourtWeightCache(
    async () => await readDb(async (tx) => await readCourtWeightRowsQuery(tx)),
  ),
  ftsConfigs: createFtsConfigCache(
    async () => await readDb(async (tx) => await readFtsConfigRowsQuery(tx)),
  ),
});

let instance: PublicCaseLawConfig | null = null;

const publicCaseLawConfig = (): PublicCaseLawConfig =>
  (instance ??= publicCaseLawConfigOver(caseLawPublicReadDb));

/** The public corpus's court registry, cached for 60 s. */
export const loadPublicCourtWeights = async (
  options?: LoadCourtWeightsOptions,
): Promise<CourtWeightMap> =>
  await publicCaseLawConfig().courtWeights.load(options);

/**
 * The public corpus's court registry, for a caller already inside a public
 * read: a miss reads on that transaction. Opening another read there would
 * ask the reader's pool, which may hold two connections, for a second one
 * while holding the first.
 */
export const loadPublicCourtWeightsWithin = async (
  tx: CaseLawConfigReadTransaction,
): Promise<CourtWeightMap> =>
  await publicCaseLawConfig().courtWeights.loadWithin(
    async () => await readCourtWeightRowsQuery(tx),
  );

/** One country's entries of the public corpus's court registry. */
export const loadPublicCourtWeightsForCountry = async (
  country: string,
): Promise<CourtWeightEntry[]> =>
  await publicCaseLawConfig().courtWeights.loadForCountry(country);

/** The text-search configurations a public search query branches on. */
export const loadPublicFtsSearchConfigs = async (): Promise<
  FtsSearchConfig[]
> => await publicCaseLawConfig().ftsConfigs.loadFtsSearchConfigs();

/**
 * Drop the cached configuration. With `readDb`, the next read goes through
 * that handle instead of the public-law reader, so a test can hold the public
 * source apart from the local one.
 */
export const resetPublicCaseLawConfigForTesting = (
  readDb?: CaseLawPublicReadDb,
): void => {
  instance = readDb === undefined ? null : publicCaseLawConfigOver(readDb);
};
