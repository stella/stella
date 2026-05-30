import { Result } from "better-result";
import { describe, expect, it } from "bun:test";

import { requireEditableSkillOrigin } from "./origin";

describe("requireEditableSkillOrigin", () => {
  it("allows user-authored skill origins to be edited", () => {
    expect(Result.isOk(requireEditableSkillOrigin("upload"))).toBe(true);
    expect(Result.isOk(requireEditableSkillOrigin("url"))).toBe(true);
  });

  it("blocks bundled catalogue skills from content and resource edits", () => {
    const result = requireEditableSkillOrigin("bundled");

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return;
    }
    expect(result.error.status).toBe(403);
  });
});
