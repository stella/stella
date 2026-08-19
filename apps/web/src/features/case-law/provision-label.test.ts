import { describe, expect, test } from "bun:test";

import type {
  ProvisionReference,
  RenderProvisionPart,
} from "@/features/case-law/provision-label";
import { formatProvisionReference } from "@/features/case-law/provision-label";

// Stands in for the catalog, in the Czech wording the example citation uses.
const render: RenderProvisionPart = (key, value) => {
  const wording = {
    article: `čl. ${value}`,
    letter: `písm. ${value})`,
    openEnded: "a násl.",
    point: `bod ${value}`,
    sentence: `věta ${value}`,
    subsection: `odst. ${value}`,
  };

  return wording[key];
};

const reference = (
  overrides: Partial<ProvisionReference> = {},
): ProvisionReference => ({
  letter: null,
  openEnded: false,
  point: null,
  section: 265,
  sectionSuffix: null,
  sentence: null,
  subsection: null,
  unit: "section",
  ...overrides,
});

describe("formatProvisionReference", () => {
  test("assembles the subdivisions in the order a citation states them", () => {
    expect(
      formatProvisionReference(
        reference({ letter: "g", sectionSuffix: "b", subsection: "1" }),
        render,
      ),
    ).toBe("§ 265b odst. 1 písm. g)");
  });

  test("an inserted provision keeps its letter on the number", () => {
    expect(
      formatProvisionReference(reference({ sectionSuffix: "b" }), render),
    ).toBe("§ 265b");
  });

  test("names an article through the catalog, not with the section sign", () => {
    expect(
      formatProvisionReference(
        reference({ section: 10, unit: "article" }),
        render,
      ),
    ).toBe("čl. 10");
  });

  test("states every subdivision a reference carries", () => {
    expect(
      formatProvisionReference(
        reference({
          letter: "a",
          point: "2",
          section: 11,
          sentence: "první",
          subsection: "3",
        }),
        render,
      ),
    ).toBe("§ 11 odst. 3 písm. a) bod 2 věta první");
  });

  test("says a reference runs on when it does", () => {
    expect(
      formatProvisionReference(reference({ openEnded: true }), render),
    ).toBe("§ 265 a násl.");
  });

  test("a subdivision the source left blank is not a subdivision", () => {
    expect(
      formatProvisionReference(
        reference({ letter: "   ", subsection: "" }),
        render,
      ),
    ).toBe("§ 265");
  });
});
