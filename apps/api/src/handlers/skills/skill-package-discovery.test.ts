import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import * as realSafeFetch from "@/api/lib/safe-outbound-fetch";
import {
  SafeOutboundFetchError,
  type SafeOutboundFetchResponse,
} from "@/api/lib/safe-outbound-fetch";

const COMMIT_SHA = "a".repeat(40);

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
    if (url.hostname === "raw.githubusercontent.com") {
      if (url.pathname.endsWith("/invalid/SKILL.md")) {
        return Result.err(
          new SafeOutboundFetchError({ message: "Request timed out" }),
        );
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
          { path: "invalid/SKILL.md", type: "blob" },
          { path: "valid/SKILL.md", type: "blob" },
        ],
      });
    }
    return response({ default_branch: "main" });
  },
}));

const { discoverSkillPackagesFromUrl } = await import("./skill-package");

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
      "valid-skill",
    ]);
  });
});
