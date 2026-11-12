import { describe, expect, test } from "bun:test";

import {
  mergeApprovedNames,
  replaceDraftNames,
} from "./make-skill-review.logic";

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

  test("a file named after a replaced name is renamed, and links to it follow", () => {
    const named = {
      markdown: "See references/acme.md and references/organization.md.",
      resources: [
        { path: "references/acme.md", content: "Acme terms." },
        { path: "references/organization.md", content: "General terms." },
      ],
    };
    expect(
      replaceDraftNames(
        named,
        [{ kind: "organization", value: "Acme" }],
        roleOf,
      ),
    ).toEqual({
      markdown:
        "See references/organization-2.md and references/organization.md.",
      resources: [
        {
          path: "references/organization-2.md",
          content: "<organization name> terms.",
        },
        { path: "references/organization.md", content: "General terms." },
      ],
    });
  });

  test("a name written with diacritics is found in its ASCII path slug", () => {
    const renamed = replaceDraftNames(
      {
        markdown: "",
        resources: [{ path: "references/jana-novakova.md", content: "" }],
      },
      [{ kind: "person", value: "Jana Nováková" }],
      roleOf,
    );
    expect(renamed.resources.map(({ path }) => path)).toEqual([
      "references/person.md",
    ]);
  });
});

describe("approved names across review rounds", () => {
  test("a name approved earlier stays approved with the new ones", () => {
    expect(
      mergeApprovedNames(["Acme"], new Set(["Jana Nováková", "Acme"])),
    ).toEqual(["Acme", "Jana Nováková"]);
  });
});
