import { describe, expect, test } from "bun:test";

import { replaceDraftNames } from "./make-skill-review.logic";

const roleOf = (kind: "person" | "organization") =>
  kind === "person" ? "<person name>" : "<organization name>";

const draft = {
  markdown:
    "Reply to Jana Nováková for Rychlé Aerolinie. Sign as Rychlé Aerolinie a.s.",
  resources: [
    {
      path: "references/style.md",
      content: "Jana Nováková prefers short replies.",
    },
  ],
};

describe("replacing names in a skill draft", () => {
  test("a replaced name becomes its role in SKILL.md and in every file", () => {
    expect(
      replaceDraftNames(
        draft,
        [{ kind: "person", value: "Jana Nováková" }],
        roleOf,
      ),
    ).toEqual({
      markdown:
        "Reply to <person name> for Rychlé Aerolinie. Sign as Rychlé Aerolinie a.s.",
      resources: [
        {
          path: "references/style.md",
          content: "<person name> prefers short replies.",
        },
      ],
    });
  });

  test("a longer name is replaced whole before a name inside it", () => {
    expect(
      replaceDraftNames(
        draft,
        [
          { kind: "organization", value: "Rychlé Aerolinie" },
          { kind: "organization", value: "Rychlé Aerolinie a.s." },
        ],
        roleOf,
      ).markdown,
    ).toBe(
      "Reply to Jana Nováková for <organization name>. Sign as <organization name>",
    );
  });

  test("names the author kept stay as they are", () => {
    expect(replaceDraftNames(draft, [], roleOf)).toEqual(draft);
  });
});
