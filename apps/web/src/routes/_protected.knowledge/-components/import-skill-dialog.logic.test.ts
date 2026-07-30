import { describe, expect, test } from "bun:test";

import { summarizeSkillImportFailures } from "./import-skill-dialog.logic";

describe("skill import failure summaries", () => {
  test("surfaces each distinct localized failure", () => {
    expect(
      summarizeSkillImportFailures(
        [
          { code: "fetch_failed" },
          { code: "name_conflict" },
          { code: "fetch_failed" },
        ],
        ({ code }) =>
          code === "fetch_failed"
            ? "Could not load the skill source"
            : "A skill with this name already exists",
        "Unexpected error",
      ),
    ).toBe(
      "Could not load the skill source; A skill with this name already exists",
    );
  });

  test("uses the fallback when localization returns no useful message", () => {
    expect(
      summarizeSkillImportFailures(
        [{ code: "fetch_failed" }],
        () => "  ",
        "Unexpected error",
      ),
    ).toBe("Unexpected error");
  });
});
