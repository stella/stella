import { describe, expect, test } from "bun:test";

import { skillRefDestination } from "./skill-ref-link";

describe("skill chip destination", () => {
  test("opens the named skill in the catalogue, not the whole list", () => {
    expect(skillRefDestination("poa-drafting")).toEqual({
      to: "/knowledge/tools",
      search: { kind: "skill", slug: "poa-drafting" },
    });
  });
});
