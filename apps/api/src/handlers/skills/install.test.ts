import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { authorizeSkillInstallScope, isUnchangedUrlSkill } from "./install";

describe("agent skill install authorization", () => {
  test("rejects team installs for non-admin organization members", () => {
    const result = authorizeSkillInstallScope({
      memberRole: { role: "member" },
      scope: "team",
    });

    expect(Result.isError(result)).toBe(true);
  });

  test("allows private installs for organization members", () => {
    const result = authorizeSkillInstallScope({
      memberRole: { role: "member" },
      scope: "private",
    });

    expect(Result.isOk(result)).toBe(true);
  });
});

describe("agent skill URL import replay", () => {
  const parsed = {
    contentHash: "a".repeat(64),
    sourceUrl: "https://example.com/SKILL.md",
  };

  test("recognizes the same URL-origin package as unchanged", () => {
    expect(
      isUnchangedUrlSkill({
        existing: { ...parsed, origin: "url" },
        origin: "url",
        parsed,
      }),
    ).toBe(true);
  });

  test("does not reuse a row with a different source or content hash", () => {
    expect(
      isUnchangedUrlSkill({
        existing: {
          contentHash: parsed.contentHash,
          origin: "url",
          sourceUrl: "https://mirror.example/SKILL.md",
        },
        origin: "url",
        parsed,
      }),
    ).toBe(false);
    expect(
      isUnchangedUrlSkill({
        existing: {
          contentHash: "b".repeat(64),
          origin: "url",
          sourceUrl: parsed.sourceUrl,
        },
        origin: "url",
        parsed,
      }),
    ).toBe(false);
  });
});
