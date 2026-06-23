import { describe, expect, test } from "bun:test";

import { hashAuthoredSkillContent } from "./authored-content-hash";

const baseSkill = {
  body: "Summarise this document.",
  description: "Get a structured summary",
  name: "Summarise a document",
  version: null,
};

describe("authored skill content hashing", () => {
  test("is deterministic", () => {
    expect(hashAuthoredSkillContent(baseSkill)).toBe(
      hashAuthoredSkillContent(baseSkill),
    );
  });

  test("changes when editable content metadata changes", () => {
    const baseHash = hashAuthoredSkillContent(baseSkill);

    expect(
      hashAuthoredSkillContent({ ...baseSkill, name: "Review a document" }),
    ).not.toBe(baseHash);
    expect(
      hashAuthoredSkillContent({
        ...baseSkill,
        description: "Review document risks",
      }),
    ).not.toBe(baseHash);
    expect(
      hashAuthoredSkillContent({ ...baseSkill, version: "1.0.0" }),
    ).not.toBe(baseHash);
    expect(
      hashAuthoredSkillContent({ ...baseSkill, body: "Find the risks." }),
    ).not.toBe(baseHash);
  });
});
