import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import * as realSafeFetch from "@/api/lib/safe-outbound-fetch";
import {
  SafeOutboundFetchError,
  type SafeOutboundFetchResponse,
} from "@/api/lib/safe-outbound-fetch";

const COMMIT_SHA = "a".repeat(40);
let outboundRequestCount = 0;

const response = (body: unknown): Result<SafeOutboundFetchResponse, never> => {
  const bytes = new TextEncoder().encode(
    typeof body === "string" ? body : JSON.stringify(body),
  );
  return Result.ok({
    body: bytes.buffer,
    headers: new Headers(),
    ok: true,
    status: 200,
  });
};

void mock.module("@/api/lib/safe-outbound-fetch", () => ({
  ...realSafeFetch,
  safeOutboundFetchBytes: async ({ url }: { url: URL }) => {
    outboundRequestCount += 1;
    if (url.hostname === "raw.githubusercontent.com") {
      if (url.pathname.endsWith("/invalid/SKILL.md")) {
        return Result.err(
          new SafeOutboundFetchError({ message: "Request timed out" }),
        );
      }
      if (url.pathname.endsWith(`/${COMMIT_SHA}/SKILL.md`)) {
        return response(`---
name: root-skill
description: A selected repository-root skill.
---

Instructions.`);
      }
      return response(`---
name: valid-skill
description: A valid discovered skill.
---

Instructions.`);
    }
    if (url.pathname.endsWith("/commits/main")) {
      return response({ sha: COMMIT_SHA });
    }
    if (url.pathname.includes("/git/trees/")) {
      return response({
        tree: [
          { path: "SKILL.md", type: "blob" },
          { path: "invalid/SKILL.md", type: "blob" },
          { path: "valid/SKILL.md", type: "blob" },
        ],
      });
    }
    return response({ default_branch: "main" });
  },
}));

const {
  createSkillPackageFetchContext,
  discoverSkillPackagesFromUrl,
  fetchSkillPackageFromUrl,
} = await import("./skill-package");

describe("GitHub skill package discovery", () => {
  test("keeps valid siblings when one skill source cannot be fetched", async () => {
    const result = await discoverSkillPackagesFromUrl(
      "https://github.com/example/skills",
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.invalidSkillCount).toBe(1);
    expect(result.value.skills.map((skill) => skill.name)).toEqual([
      "root-skill",
      "valid-skill",
    ]);
  });

  test("keeps direct root SKILL.md discovery scoped to that file", async () => {
    const result = await discoverSkillPackagesFromUrl(
      `https://github.com/example/skills/blob/${COMMIT_SHA}/SKILL.md`,
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.invalidSkillCount).toBe(0);
    expect(result.value.skills.map((skill) => skill.name)).toEqual([
      "root-skill",
    ]);
  });

  test("stops a batch before exceeding its GitHub request budget", async () => {
    outboundRequestCount = 0;
    const result = await fetchSkillPackageFromUrl(
      `https://github.com/example/skills/tree/${COMMIT_SHA}`,
      createSkillPackageFetchContext({
        deadlineAt: Date.now() + 30_000,
        maxRequests: 1,
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected the request budget to reject the import");
    }
    expect(result.error.message).toBe(
      "Skill import exceeded its outbound request limit",
    );
    expect(outboundRequestCount).toBe(1);
  });

  test("rejects an expired batch deadline before outbound I/O", async () => {
    outboundRequestCount = 0;
    const result = await fetchSkillPackageFromUrl(
      `https://github.com/example/skills/tree/${COMMIT_SHA}`,
      createSkillPackageFetchContext({
        deadlineAt: Date.now() - 1,
        maxRequests: 10,
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected the expired deadline to reject the import");
    }
    expect(result.error.message).toBe("Skill import timed out");
    expect(outboundRequestCount).toBe(0);
  });

  test("applies the batch deadline to non-GitHub sources", async () => {
    outboundRequestCount = 0;
    const result = await fetchSkillPackageFromUrl(
      "https://example.com/SKILL.md",
      createSkillPackageFetchContext({
        deadlineAt: Date.now() - 1,
        maxRequests: 10,
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected the expired deadline to reject the import");
    }
    expect(result.error.message).toBe("Skill import timed out");
    expect(outboundRequestCount).toBe(0);
  });
});
