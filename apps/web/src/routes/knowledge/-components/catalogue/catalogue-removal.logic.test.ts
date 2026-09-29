import { describe, expect, test } from "bun:test";

import { catalogueRemoval } from "./catalogue-removal.logic";
import type {
  CatalogueMcp,
  CatalogueNativeTool,
  CatalogueSkill,
} from "./catalogue-types";

describe("catalogue removal", () => {
  test("removing an installed skill asks for confirmation", () => {
    expect(catalogueRemoval(skillEntry({ installedSkillId: "skill-1" }))).toBe(
      "confirm",
    );
  });

  test("removing an installed integration asks for confirmation", () => {
    expect(
      catalogueRemoval(mcpEntry({ installedConnectorSlug: "krs-connector" })),
    ).toBe("confirm");
  });

  test("turning off a built-in tool happens at once", () => {
    expect(catalogueRemoval(nativeToolEntry({}))).toBe("immediate");
  });

  test("a skill without an edit handle cannot be removed", () => {
    expect(catalogueRemoval(skillEntry({ installedSkillId: null }))).toBe(
      "none",
    );
  });

  test("a locked tool cannot be removed", () => {
    expect(catalogueRemoval(nativeToolEntry({ isLocked: true }))).toBe("none");
  });

  test("an entry that is not installed cannot be removed", () => {
    expect(
      catalogueRemoval(
        skillEntry({ installState: "available", installedSkillId: "skill-1" }),
      ),
    ).toBe("none");
  });

  test("a built-in tool already turned off cannot be removed again", () => {
    expect(catalogueRemoval(nativeToolEntry({ enabled: false }))).toBe("none");
  });
});

const commonFields = (): Omit<CatalogueSkill, "kind"> => ({
  author: "Stella",
  chatSkillId: null,
  cost: "free",
  description: "Entry.",
  displayName: "Entry",
  enabled: true,
  icon: null,
  installState: "installed",
  installedConnectorSlug: null,
  installedSkillId: null,
  isLocked: false,
  isRecommendedForOrg: false,
  jurisdictions: [],
  license: "MIT",
  setup: "none",
  slug: "entry",
  tags: [],
});

const skillEntry = (overrides: Partial<CatalogueSkill>): CatalogueSkill => ({
  ...commonFields(),
  kind: "skill",
  ...overrides,
});

const mcpEntry = (overrides: Partial<CatalogueMcp>): CatalogueMcp => ({
  ...commonFields(),
  kind: "mcp",
  url: "https://mcp.example.test",
  authType: "none",
  oauthRequestedScopes: [],
  allowedTools: [],
  ...overrides,
});

const nativeToolEntry = (
  overrides: Partial<CatalogueNativeTool>,
): CatalogueNativeTool => ({
  ...commonFields(),
  kind: "native-tool",
  backendSlug: "web-search",
  pinned: false,
  ...overrides,
});
