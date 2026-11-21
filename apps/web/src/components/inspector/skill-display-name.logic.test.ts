import { describe, expect, test } from "bun:test";

import { findInstalledSkillDisplayName } from "./skill-display-name.logic";

const PAGES = [
  { installed: [{ id: "skill-1", name: "Team review" }] },
  { installed: [{ id: "skill-2", name: "NDA check" }] },
];

describe("the title an installed skill's resource tab stores", () => {
  test("an installed skill is named by its row, on any page", () => {
    expect(
      findInstalledSkillDisplayName({ pages: PAGES, skillId: "skill-2" }),
    ).toBe("NDA check");
  });

  test("no title while the list is not loaded or no longer has the skill", () => {
    expect(
      findInstalledSkillDisplayName({ pages: undefined, skillId: "gone" }),
    ).toBeUndefined();
    expect(
      findInstalledSkillDisplayName({ pages: PAGES, skillId: "gone" }),
    ).toBeUndefined();
  });
});
