import { describe, expect, test } from "bun:test";

import { sha256Hex } from "@stll/sha256/bun";
import { validateSkillPackage } from "@stll/skills/format";

import { pinnedLicenseMismatchError } from "../scripts/check-pinned-content";
import {
  PinnedContentError,
  assertCompleteGithubContentsListing,
  syntheticSkillSource,
} from "../scripts/pinned-content-facts";
import {
  fetchDirectoryContents,
  fetchPinnedTextFile,
  fetchWithBoundedRetry,
} from "../scripts/pinned-content-upstream";

const GITHUB_TARGET = {
  directory: "skills/example",
  license: "MIT",
  repo: "example/skills",
  rev: "a".repeat(40),
  slug: "example",
} as const;

const closedSocketResponse = (): Response =>
  new Response(
    new ReadableStream({
      pull: (controller) => {
        controller.error(new TypeError("socket closed during body read"));
      },
    }),
  );

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

  test("retries a body-read failure through the pinned-file path", async () => {
    let attempts = 0;
    const delays: number[] = [];

    const file = await fetchPinnedTextFile({
      fetcher: async () => {
        attempts += 1;
        return attempts === 1
          ? closedSocketResponse()
          : new Response("pinned content");
      },
      label: "SKILL.md",
      maxBytes: 1024,
      repoRelativePath: "skills/example/SKILL.md",
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      target: GITHUB_TARGET,
    });

    expect(file).toEqual({
      byteLength: 14,
      content: "pinned content",
      sha256: sha256Hex("pinned content"),
    });
    expect(attempts).toBe(2);
    expect(delays).toEqual([200]);
  });

  test("retries a body-read failure through the contents path", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const contents = [
      {
        path: "skills/example/references/source.md",
        size: 12,
        type: "file",
      },
    ];

    const result = await fetchDirectoryContents({
      fetcher: async () => {
        attempts += 1;
        return attempts === 1
          ? closedSocketResponse()
          : new Response(JSON.stringify(contents));
      },
      repoRelativePath: "skills/example/references",
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      target: GITHUB_TARGET,
    });

    expect(result).toEqual({ items: contents, itemCount: contents.length });
    expect(attempts).toBe(2);
    expect(delays).toEqual([200]);
  });
});

describe("pinned skill install-limit preflight", () => {
  test("reconstructs adjacent resource references within the recorded body length", () => {
    const referencedResourcePaths = ["references/a.md", "references/b.md"];
    const bodyLength = referencedResourcePaths.reduce(
      (length, resourcePath) => length + resourcePath.length + 2,
      0,
    );
    const source = syntheticSkillSource(
      {
        compatibilityUtf16Length: 0,
        descriptionUtf16Length: 7,
        license: null,
        licenseUtf16Length: 0,
        metadata: [],
        name: "example",
        versionUtf16Length: 0,
      },
      bodyLength,
      referencedResourcePaths,
    );
    const result = validateSkillPackage({
      files: [
        { content: source, path: "SKILL.md" },
        { content: "a", path: "references/a.md" },
        { content: "b", path: "references/b.md" },
      ],
      tools: { type: "deferred" },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.body).toBe("`references/a.md``references/b.md`");
    }
  });

  test("rejects pinned references longer than the recorded body", () => {
    expect(() =>
      syntheticSkillSource(
        {
          compatibilityUtf16Length: 0,
          descriptionUtf16Length: 7,
          license: null,
          licenseUtf16Length: 0,
          metadata: [],
          name: "example",
          versionUtf16Length: 0,
        },
        1,
        ["references/a.md"],
      ),
    ).toThrow("Pinned skill references exceed the recorded body length");
  });

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
});
