import { describe, expect, test } from "bun:test";

import { getChangelogReleases } from "./changelog";

describe("changelog release dates", () => {
  // A release page without a date entry renders dateless silently; the entry
  // lives in src/data/changelog-release-dates.json (GitHub `published_at`,
  // `gh release view <tag> --json publishedAt`). Add it with the release page.
  test("every release page has a publication date", () => {
    const undated = getChangelogReleases()
      .filter((release) => release.publishedAt === null)
      .map((release) => release.tagName);
    expect(undated).toEqual([]);
  });
});
