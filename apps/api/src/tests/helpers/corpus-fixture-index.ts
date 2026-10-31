import {
  corpusIndexConfigFromManifest,
  type CorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";

// Keep committed-ingest receipts while avoiding the production batching window.
export const corpusFixtureIndexConfig = (
  manifest: CorpusIndexManifest,
  indexId: string,
) => {
  const config = corpusIndexConfigFromManifest(manifest, indexId);
  return {
    ...config,
    indexing_settings: {
      ...config.indexing_settings,
      commit_timeout_secs: 1,
    },
  };
};
