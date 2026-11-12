import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { safeOutboundFetchBytes } from "@/api/lib/auth/authorized-outbound-fetch";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeOutboundFetchResponse } from "@/api/lib/safe-outbound-fetch";
import {
  discoverSkillPackagesFromUrl,
  githubSkillFetchHeaders,
} from "@/api/lib/skills/skill-package";

const PUBLIC_TOKEN = "public-repositories-only";
const CATALOGUE_TOKEN = "catalogue-token";
const COMMIT_SHA = "a".repeat(40);

const response = (body: unknown): Result<SafeOutboundFetchResponse, never> =>
  Result.ok({
    body: new TextEncoder().encode(
      typeof body === "string" ? body : JSON.stringify(body),
    ).buffer,
    headers: new Headers(),
    ok: true,
    status: 200,
  });

type RecordedRequest = { authorization: string | undefined; host: string };

const recordingFetch = (
  requests: RecordedRequest[],
): typeof safeOutboundFetchBytes =>
  async function recordRequest({ headers, url }) {
    const requestUrl = typeof url === "string" ? new URL(url) : url;
    requests.push({
      authorization: new Headers(headers).get("authorization") ?? undefined,
      host: requestUrl.hostname,
    });
    if (requestUrl.hostname === "raw.githubusercontent.com") {
      return response(`---
name: linked-skill
description: A skill from a linked repository.
---

Instructions.`);
    }
    if (requestUrl.pathname.includes("/commits/")) {
      return response({ sha: COMMIT_SHA });
    }
    if (requestUrl.pathname.includes("/git/trees/")) {
      return response({ tree: [{ path: "SKILL.md", type: "blob" }] });
    }
    return response({ default_branch: "main" });
  };

describe("GitHub tokens for skill sources", () => {
  test("a linked source sends the public token to the GitHub API only", () => {
    expect(
      githubSkillFetchHeaders({
        access: { source: "user" },
        hostname: "api.github.com",
        publicGithubToken: PUBLIC_TOKEN,
      })["Authorization"],
    ).toBe(`Bearer ${PUBLIC_TOKEN}`);
    for (const hostname of ["raw.githubusercontent.com", "example.com"]) {
      expect(
        githubSkillFetchHeaders({
          access: { source: "user" },
          hostname,
          publicGithubToken: PUBLIC_TOKEN,
        })["Authorization"],
      ).toBeUndefined();
    }
  });

  test("a linked source without the public token stays anonymous", () => {
    expect(
      githubSkillFetchHeaders({
        access: { source: "user" },
        hostname: "api.github.com",
      })["Authorization"],
    ).toBeUndefined();
  });

  test("a catalogue read keeps its own token and never the public one", () => {
    expect(
      githubSkillFetchHeaders({
        access: { githubToken: CATALOGUE_TOKEN, source: "catalogue" },
        hostname: "api.github.com",
        publicGithubToken: PUBLIC_TOKEN,
      })["Authorization"],
    ).toBe(`Bearer ${CATALOGUE_TOKEN}`);
    expect(
      githubSkillFetchHeaders({
        access: { source: "catalogue" },
        hostname: "api.github.com",
        publicGithubToken: PUBLIC_TOKEN,
      })["Authorization"],
    ).toBeUndefined();
  });

  test("discovery from a linked repository authenticates only API requests", async () => {
    const requests: RecordedRequest[] = [];
    const result = await discoverSkillPackagesFromUrl({
      fetchBytes: recordingFetch(requests),
      permit: grantThirdPartyOutboundPermit(),
      publicGithubToken: PUBLIC_TOKEN,
      rawUrl: "https://github.com/example/skills",
    });

    expect(Result.isOk(result)).toBe(true);
    const apiRequests = requests.filter(
      (request) => request.host === "api.github.com",
    );
    const rawRequests = requests.filter(
      (request) => request.host === "raw.githubusercontent.com",
    );
    expect(apiRequests.length).toBeGreaterThan(0);
    expect(rawRequests.length).toBeGreaterThan(0);
    expect(
      apiRequests.every(
        (request) => request.authorization === `Bearer ${PUBLIC_TOKEN}`,
      ),
    ).toBe(true);
    expect(rawRequests.every((request) => !request.authorization)).toBe(true);
  });

  test("discovery without the public token sends no credentials", async () => {
    const requests: RecordedRequest[] = [];
    await discoverSkillPackagesFromUrl({
      fetchBytes: recordingFetch(requests),
      permit: grantThirdPartyOutboundPermit(),
      rawUrl: "https://github.com/example/skills",
    });

    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => !request.authorization)).toBe(true);
  });
});
