import { describe, expect, test } from "bun:test";

import { summarizeSkillImportFailures } from "./import-skill-dialog.logic";

describe("skill import failure summaries", () => {
  test("surfaces each distinct actionable server message", () => {
    expect(
      summarizeSkillImportFailures(
        [
          { message: "Skill limit reached" },
          { message: "Skill slug already exists" },
          { message: "Skill limit reached" },
        ],
        "Unexpected error",
      ),
    ).toBe("Skill limit reached; Skill slug already exists");
  });

  test("uses the fallback when the server returns no useful message", () => {
    expect(
      summarizeSkillImportFailures(
        [{ message: "  " }, { message: "" }],
        "Unexpected error",
      ),
    ).toBe("Unexpected error");
  });
});
