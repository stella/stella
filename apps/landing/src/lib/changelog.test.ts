import { describe, expect, test } from "bun:test";

import {
  getChangelogReleaseEntries,
  getChangelogReleases,
  getUnpromotedReleaseTags,
} from "./changelog";

describe("changelog release dates", () => {
  // A release page without a date entry renders dateless silently; the entry
  // lives in src/data/changelog-release-dates.json (GitHub `published_at`,
  // `gh release view <tag> --json publishedAt`). Release automation commits
  // the page without the date entry, so the newest release gets a grace
  // window; anything older undated is the staleness this guard exists for
  // (the file once stopped six feature releases behind).
  test("every release page except the newest has a publication date", () => {
    const undated = getChangelogReleases()
      .slice(1)
      .filter((release) => release.publishedAt === null)
      .map((release) => release.tagName);
    expect(undated).toEqual([]);
  });

  // A stable tag that was built but never promoted has its notes file (the
  // release cut requires one) and a `null` date entry; it must not surface
  // anywhere the list feeds: the changelog, its preview pages, the homepage.
  test("a release recorded as never promoted is omitted", () => {
    const unpromoted = getUnpromotedReleaseTags();
    expect(unpromoted).toContain("v0.8.10");
    const listed = new Set(
      getChangelogReleases().map(({ tagName }) => tagName),
    );
    for (const tagName of unpromoted) {
      expect([tagName, listed.has(tagName)]).toEqual([tagName, false]);
    }
  });

  test("grouped entries preserve every release exactly once", () => {
    const releases = getChangelogReleases();
    const groupedReleases = getChangelogReleaseEntries().flatMap((entry) =>
      entry.type === "maintenance" ? entry.releases : [entry.release],
    );

    expect(groupedReleases.map(({ tagName }) => tagName)).toEqual(
      releases.map(({ tagName }) => tagName),
    );
  });
});

describe("changelog descriptions and bodies", () => {
  test("never uses a Packages section heading as a release description", () => {
    const broken = getChangelogReleases()
      .filter((release) => release.description === "Packages")
      .map((release) => release.tagName);
    expect(broken).toEqual([]);
  });

  test("uses the opening prose paragraph when a release has no subtitle heading", () => {
    const releases = new Map(
      getChangelogReleases().map((release) => [release.tagName, release]),
    );
    expect(releases.get("v0.9.89")?.description).toBe(
      "stella includes reliability and maintenance improvements.",
    );
    expect(releases.get("v0.9.24")?.description).toBe(
      "Case law and statutes open in the legal database.",
    );
    expect(releases.get("v0.9.88")?.body).toContain("legal-file-formats.mp4");
  });
});
