import { expect, test } from "bun:test";

import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexConfigFromManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";

import { corpusFixtureIndexConfig } from "./corpus-fixture-index";

test("fixture indexes commit promptly without changing production settings", () => {
  const manifest = CORPUS_INDEX_MANIFESTS.legislation_v2;
  const indexId = "legislation_v2_fixture";
  const production = corpusIndexConfigFromManifest(manifest, indexId);
  const fixture = corpusFixtureIndexConfig(manifest, indexId);

  expect(production.indexing_settings.commit_timeout_secs).toBe(60);
  expect(fixture.indexing_settings.commit_timeout_secs).toBe(1);
  expect(fixture).toEqual({
    ...production,
    indexing_settings: {
      ...production.indexing_settings,
      commit_timeout_secs: 1,
    },
  });
  expect(
    manifest.engine.indexConfig.indexing_settings.commit_timeout_secs,
  ).toBe(60);
  expect(corpusIndexConfigFromManifest(manifest, indexId)).toEqual(production);
});
