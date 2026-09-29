import { describe, expect, test } from "bun:test";

import { findSkillDisplayName } from "./skill-display-name.logic";

const PAGES = [
  {
    builtIn: [
      {
        id: "playbook-builder",
        name: "Build a playbook",
        slug: "playbook-builder",
      },
    ],
    installed: [{ id: "skill-1", name: "Team review", slug: "review" }],
  },
  {
    builtIn: [
      {
        id: "playbook-builder",
        name: "Build a playbook",
        slug: "playbook-builder",
      },
    ],
    installed: [{ id: "skill-2", name: "NDA check", slug: "nda" }],
  },
];

describe("the title a skill resource tab shows", () => {
  test("a built-in is named by the list row with its slug", () => {
    expect(
      findSkillDisplayName({
        pages: PAGES,
        skillName: "playbook-builder",
        source: { origin: "built-in", skillId: null },
      }),
    ).toBe("Build a playbook");
  });

  test("an installed skill is named by its row, on any page", () => {
    expect(
      findSkillDisplayName({
        pages: PAGES,
        skillName: "nda",
        source: { origin: "authored", skillId: "skill-2" },
      }),
    ).toBe("NDA check");
  });

  test("an installed skill sharing a built-in's slug keeps its own title", () => {
    expect(
      findSkillDisplayName({
        pages: [
          {
            builtIn: PAGES[0]?.builtIn ?? [],
            installed: [
              {
                id: "skill-3",
                name: "Our playbooks",
                slug: "playbook-builder",
              },
            ],
          },
        ],
        skillName: "playbook-builder",
        source: { origin: "authored", skillId: "skill-3" },
      }),
    ).toBe("Our playbooks");
  });

  test("no title while the list is not loaded or no longer has the skill", () => {
    const source = { origin: "authored", skillId: "gone" } as const;
    expect(
      findSkillDisplayName({ pages: undefined, skillName: "x", source }),
    ).toBeUndefined();
    expect(
      findSkillDisplayName({ pages: PAGES, skillName: "x", source }),
    ).toBeUndefined();
  });
});
