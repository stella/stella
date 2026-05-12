import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { authorizeSkillInstallScope } from "./install";

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
