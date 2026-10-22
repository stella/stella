import { afterEach, expect, test } from "bun:test";

import { useExternalSourceStore } from "./external-source-store";
import {
  collectExternalSources,
  dedupeExternalSources,
} from "./source-chips.logic";
import type { ExternalSourceEntry } from "./source-chips.logic";

afterEach(() => useExternalSourceStore.setState({ sourcesByUrl: {} }));

test("primary and publisher hrefs resolve to the same citation after extraction and registration", () => {
  const sources: ExternalSourceEntry[] = [];
  const url = "https://app.example.test/law/cze/statutes/89-2012-sb#par_1729";
  const source_url = "https://publisher.example.test";
  collectExternalSources({ url, source_url, title: "§ 1729" }, sources);
  collectExternalSources(
    { url, sourceUrl: source_url, title: "§ 1729" },
    sources,
  );
  const entries = dedupeExternalSources(sources);
  useExternalSourceStore.setState({ sourcesByUrl: {} });
  useExternalSourceStore.getState().registerSources(entries);
  const state = useExternalSourceStore.getState();
  const primary = state.getSource(url);
  expect(primary?.url).toBe(url);
  expect(primary?.sourceUrl).toBe(source_url);
  expect(state.getSource(new URL(source_url).href)).toEqual(primary);
});

test("relative corpus routes survive extraction without becoming publisher identities", () => {
  const sources: ExternalSourceEntry[] = [];
  const url = "/law/cze/statutes/89-2012-sb#par_1729";
  collectExternalSources(
    { url, source_url: "https://publisher.example.test/act", title: "§ 1729" },
    sources,
  );
  expect(sources).toHaveLength(1);
  expect(sources.at(0)).toMatchObject({
    url,
    sourceUrl: "https://publisher.example.test/act",
  });
});

for (const readerFirst of [true, false]) {
  test(`publisher refreshes preserve the primary reader URL (reader first: ${String(readerFirst)})`, () => {
    const url = "https://app.example.test/law/cze/statutes/89-2012-sb#par_1729";
    const sourceUrl = "https://publisher.example.test";
    const reader = { url, sourceUrl, title: "§ 1729" };
    const publisher = { url: new URL(sourceUrl).href, title: "§ 1729" };
    const sources = readerFirst ? [reader, publisher] : [publisher, reader];
    const state = useExternalSourceStore.getState();
    for (const source of sources) {
      state.registerSources([source]);
    }
    expect(state.getSource(url)?.url).toBe(url);
    expect(state.getSource(sourceUrl)).toEqual(state.getSource(url));
  });
}
