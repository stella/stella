import { describe, expect, it } from "bun:test";

import {
  buildCommitsApiUrl,
  buildCompareUrl,
  catalogueManifestPath,
  hasUpstreamUpdate,
  parseLatestCommitSha,
} from "../scripts/check-upstream";

const FULL_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

describe("buildCommitsApiUrl", () => {
  it("adds the directory path filter when a directory is set", () => {
    expect(
      buildCommitsApiUrl({
        directory: "skills/german-law",
        repo: "acme/legal",
      }),
    ).toBe(
      "https://api.github.com/repos/acme/legal/commits?per_page=1&path=skills%2Fgerman-law",
    );
  });

  it("omits the path filter for a repo-root skill", () => {
    expect(buildCommitsApiUrl({ directory: null, repo: "acme/legal" })).toBe(
      "https://api.github.com/repos/acme/legal/commits?per_page=1",
    );
  });
});

describe("parseLatestCommitSha", () => {
  it("returns the first commit SHA from a well-formed response", () => {
    expect(parseLatestCommitSha([{ sha: FULL_SHA }, { sha: OTHER_SHA }])).toBe(
      FULL_SHA,
    );
  });

  it("returns null for an empty array (no commits touched the path)", () => {
    expect(parseLatestCommitSha([])).toBeNull();
  });

  it("returns null for a non-array payload (e.g. an API error object)", () => {
    expect(parseLatestCommitSha({ message: "Not Found" })).toBeNull();
  });

  it("returns null when the SHA is missing or malformed", () => {
    expect(parseLatestCommitSha([{}])).toBeNull();
    expect(parseLatestCommitSha([{ sha: "abc123" }])).toBeNull();
    expect(parseLatestCommitSha([{ sha: FULL_SHA.toUpperCase() }])).toBeNull();
  });
});

describe("hasUpstreamUpdate", () => {
  it("is false when the pinned and latest SHAs match", () => {
    expect(hasUpstreamUpdate(FULL_SHA, FULL_SHA)).toBe(false);
  });

  it("is true when the upstream SHA advanced", () => {
    expect(hasUpstreamUpdate(FULL_SHA, OTHER_SHA)).toBe(true);
  });
});

describe("url and path helpers", () => {
  it("builds a compare url between the pinned and latest SHAs", () => {
    expect(
      buildCompareUrl({
        currentRev: FULL_SHA,
        latestRev: OTHER_SHA,
        repo: "acme/legal",
      }),
    ).toBe(`https://github.com/acme/legal/compare/${FULL_SHA}...${OTHER_SHA}`);
  });

  it("builds the repo-root-relative manifest path", () => {
    expect(catalogueManifestPath("german-law")).toBe(
      "packages/catalogue/entries/skills/german-law/manifest.json",
    );
  });
});
