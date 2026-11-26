import { describe, expect, test } from "bun:test";

import {
  courtListenerIngestFixture,
  fixtureCitedIndexes,
  fixtureDocketIndex,
  fixturePrimaryCitation,
} from "./case-law-ingest-fixture";

const namespace = 7009;
const count = 60;
const stream = courtListenerIngestFixture({ count, namespace });

/** What record `index` publishes as its identifiers. */
const published = (index: number): string =>
  JSON.stringify(stream[index]?.identifiers ?? null);

const text = (index: number): string => stream[index]?.fulltext ?? "";

describe("courtListenerIngestFixture", () => {
  test("a record cites an ordinary later record by the citation it publishes", () => {
    const { later } = fixtureCitedIndexes(10, count);
    expect(fixtureDocketIndex(later)).toBe(later);
    expect(published(later)).toContain(String(1000 + later));
    expect(text(10)).toContain(fixturePrimaryCitation(namespace, later));
  });

  test("a record citing a repeat cites the citation both records publish", () => {
    // Record 37 cites record 40, which repeats record 39's citation.
    const { later } = fixtureCitedIndexes(37, count);
    expect(later).toBe(40);
    expect(fixtureDocketIndex(later)).toBe(39);
    expect(published(39)).toContain("1039");
    expect(published(40)).toContain("1039");
    expect(text(37)).toContain(fixturePrimaryCitation(namespace, 40));
    expect(fixturePrimaryCitation(namespace, 40)).toBe(
      `${namespace} U.S. 1039`,
    );
  });
});
