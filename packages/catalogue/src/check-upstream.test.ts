import { describe, expect, it } from "bun:test";

import {
  buildCommitsApiUrl,
  buildCompareUrl,
  buildSkillFileApiUrl,
  catalogueManifestPath,
  hasUpstreamUpdate,
  inspectUpstreamTarget,
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

describe("inspectUpstreamTarget", () => {
  it("reports an installable candidate as an update", async () => {
    let requestCount = 0;
    const fetcher = async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify([{ sha: OTHER_SHA }]), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ type: "file" }), { status: 200 });
    };

    const state = await inspectUpstreamTarget(
      {
        currentRev: FULL_SHA,
        directory: "skills/german-law",
        repo: "acme/legal",
        slug: "german-law",
      },
      fetcher,
    );

    expect(state).toEqual({ latestRev: OTHER_SHA, status: "update" });
    expect(requestCount).toBe(2);
  });

  it("keeps the reviewed pin when the latest directory commit deleted SKILL.md", async () => {
    let requestCount = 0;
    const fetcher = async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify([{ sha: OTHER_SHA }]), {
          status: 200,
        });
      }
      return new Response(null, { status: 404 });
    };

    const state = await inspectUpstreamTarget(
      {
        currentRev: FULL_SHA,
        directory: "skills/german-law",
        repo: "acme/legal",
        slug: "german-law",
      },
      fetcher,
    );

    expect(state).toEqual({ latestRev: OTHER_SHA, status: "missing" });
    expect(requestCount).toBe(2);
  });

  it("does not probe SKILL.md when the tracked directory has not changed", async () => {
    let requestCount = 0;
    const fetcher = async () => {
      requestCount += 1;
      return new Response(JSON.stringify([{ sha: FULL_SHA }]), {
        status: 200,
      });
    };

    const state = await inspectUpstreamTarget(
      {
        currentRev: FULL_SHA,
        directory: null,
        repo: "acme/legal",
        slug: "german-law",
      },
      fetcher,
    );

    expect(state).toEqual({ latestRev: FULL_SHA, status: "current" });
    expect(requestCount).toBe(1);
  });

  it("surfaces candidate probe errors instead of treating them as missing", async () => {
    let requestCount = 0;
    const fetcher = async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify([{ sha: OTHER_SHA }]), {
          status: 200,
        });
      }
      return new Response(null, { status: 503 });
    };

    // Bun types declare `.rejects.toThrow` as void; capture explicitly so
    // type-aware lint and the runtime agree.
    const rejection: unknown = await inspectUpstreamTarget(
      {
        currentRev: FULL_SHA,
        directory: "skills/german-law",
        repo: "acme/legal",
        slug: "german-law",
      },
      fetcher,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: "GitHub contents API returned HTTP 503",
    });
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

  it("builds the candidate SKILL.md contents URL", () => {
    expect(
      buildSkillFileApiUrl({
        directory: "skills/german law",
        repo: "acme/legal",
        rev: FULL_SHA,
      }),
    ).toBe(
      `https://api.github.com/repos/acme/legal/contents/skills/german%20law/SKILL.md?ref=${FULL_SHA}`,
    );
    expect(
      buildSkillFileApiUrl({
        directory: null,
        repo: "acme/legal",
        rev: FULL_SHA,
      }),
    ).toBe(
      `https://api.github.com/repos/acme/legal/contents/SKILL.md?ref=${FULL_SHA}`,
    );
  });
});
