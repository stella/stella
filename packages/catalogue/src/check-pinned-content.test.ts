import { describe, expect, test } from "bun:test";

import { SKILL_PACKAGE_LIMITS } from "@stll/skills/package-limits";

import {
  archiveSizeLimitError,
  assertCompleteGithubContentsListing,
  checkFrontmatterLimits,
  fetchWithBoundedRetry,
  PinnedContentError,
  pinnedLicenseMismatchError,
  registerResourcePath,
  resourceContentLimitError,
  resourcePathLimitError,
} from "../scripts/check-pinned-content";

describe("pinned content fetch retry", () => {
  test("retries rejected transports with bounded backoff", async () => {
    let attempts = 0;
    const delays: number[] = [];

    const result = await fetchWithBoundedRetry({
      fetchValue: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new TypeError("socket closed");
        }
        return "ok";
      },
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(delays).toEqual([200, 800]);
  });

  test("stops after three rejected transport attempts", async () => {
    const failure = new TypeError("socket stayed closed");
    let attempts = 0;

    const response = fetchWithBoundedRetry({
      fetchValue: async () => {
        attempts += 1;
        throw failure;
      },
      sleep: async () => {},
    });

    // Bun types declare `.rejects.toBe` as void; capture explicitly so
    // type-aware lint and the runtime agree.
    const rejection: unknown = await response.then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBe(failure);
    expect(attempts).toBe(3);
  });

  test("does not retry tagged HTTP failures", async () => {
    const failure = new PinnedContentError({
      message: "fetch returned HTTP 503",
    });
    let attempts = 0;

    const response = fetchWithBoundedRetry({
      fetchValue: async () => {
        attempts += 1;
        throw failure;
      },
      sleep: async () => {},
    });

    const rejection: unknown = await response.then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBe(failure);
    expect(attempts).toBe(1);
  });
});

describe("pinned skill install-limit preflight", () => {
  test("rejects GitHub Contents listings that may have hit the API ceiling", () => {
    expect(() =>
      assertCompleteGithubContentsListing({
        itemCount: 1000,
        repoRelativePath: "skills/review/references",
      }),
    ).toThrow(/listing may be truncated/u);
    expect(() =>
      assertCompleteGithubContentsListing({
        itemCount: 999,
        repoRelativePath: "skills/review/references",
      }),
    ).not.toThrow();
  });
  test("reports frontmatter fields and metadata rejected at install time", () => {
    const errors = checkFrontmatterLimits("oversized", {
      compatibility: null,
      description: "d".repeat(SKILL_PACKAGE_LIMITS.descriptionMaxChars + 1),
      license: null,
      metadata: Object.fromEntries(
        Array.from(
          { length: SKILL_PACKAGE_LIMITS.metadataEntriesMax + 1 },
          (_, index) => [`key-${index}`, "value"],
        ),
      ),
      name: "oversized",
      version: null,
    });

    expect(errors.some((error) => error.includes("description"))).toBe(true);
    expect(errors.some((error) => error.includes("metadata has"))).toBe(true);
  });

  test("requires the pinned license to match the reviewed manifest", () => {
    expect(
      pinnedLicenseMismatchError({
        catalogueLicense: "MIT",
        slug: "missing-license",
        upstreamLicense: null,
      }),
    ).toContain("license does not match");
    expect(
      pinnedLicenseMismatchError({
        catalogueLicense: "MIT",
        slug: "changed-license",
        upstreamLicense: "Apache-2.0",
      }),
    ).toContain("license does not match");
    expect(
      pinnedLicenseMismatchError({
        catalogueLicense: "MIT",
        slug: "matching-license",
        upstreamLicense: " mit ",
      }),
    ).toBeNull();
  });

  test("rejects decoded resource characters below the byte fetch cap", () => {
    const error = resourceContentLimitError({
      content: "a".repeat(SKILL_PACKAGE_LIMITS.resourceMaxChars + 1),
      path: "references/large.txt",
      slug: "ascii-heavy",
    });

    expect(error).toContain(
      `${SKILL_PACKAGE_LIMITS.resourceMaxChars + 1} chars`,
    );
  });

  test("counts SKILL.md bytes toward the package archive limit", () => {
    const error = archiveSizeLimitError({
      resourceBytes: 11,
      skillFileBytes: SKILL_PACKAGE_LIMITS.archiveUncompressedMaxBytes - 10,
      slug: "combined-oversize",
    });

    expect(error).toContain("skill package exceeds");
  });

  test("rejects resource paths longer than the persistence boundary", () => {
    const path = `references/${"a".repeat(SKILL_PACKAGE_LIMITS.resourcePathMaxChars)}.md`;

    expect(resourcePathLimitError({ path, slug: "long-path" })).toContain(
      `${path.length} chars`,
    );
  });

  test("reports paths that collide after normalization", () => {
    const seenPaths = new Set<string>();
    expect(
      registerResourcePath({
        path: "references/same.md",
        seenPaths,
        slug: "duplicate-path",
      }),
    ).toBeNull();
    expect(
      registerResourcePath({
        path: "references/same.md",
        seenPaths,
        slug: "duplicate-path",
      }),
    ).toContain("duplicate normalized resource path references/same.md");
  });
});
