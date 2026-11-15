import { describe, expect, test } from "bun:test";

import { unapprovedSkillDraftNames } from "./draft-names";

const names = [
  { kind: "person", value: "Jana Nováková" },
  { kind: "organization", value: "Rychlé Aerolinie a.s." },
] as const;

describe("names a skill draft holds", () => {
  test("every name is unapproved until its author approves it", () => {
    expect(unapprovedSkillDraftNames(names, [])).toEqual([...names]);
  });

  test("approval matches a name whatever its case or Unicode form", () => {
    expect(
      unapprovedSkillDraftNames(names, [
        "JANA NOVÁKOVÁ",
        "Rychlé Aerolinie a.s.",
      ]),
    ).toEqual([]);
  });

  test("approving one name leaves the others to approve", () => {
    expect(unapprovedSkillDraftNames(names, ["Jana Nováková"])).toEqual([
      names[1],
    ]);
  });
});
