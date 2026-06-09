import { describe, expect, test } from "bun:test";

import { BLUEPRINT_IDS, BLUEPRINTS, getBlueprint } from "./blueprints";
import { isAllowedResourcePath, parseSkillFile } from "./loader";

// Frontmatter name rule the upload/import parser enforces (skill-package.ts).
// Blueprint instantiation reuses that parser, so a blueprint with a bad name
// would 400 at runtime instead of seeding a draft.
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

// The file-tree editor (apps/web) only renders paths whose every segment
// starts alphanumeric. A `_guide.md`-style segment stores fine via the loader
// but breaks rename/create later, so guard it here at authoring time.
const FILE_TREE_PATH_PATTERN =
  /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/u;

describe("skill blueprints", () => {
  test("every advertised blueprint id resolves", () => {
    for (const id of BLUEPRINT_IDS) {
      expect(getBlueprint(id)?.id).toBe(id);
    }
  });

  for (const blueprint of BLUEPRINTS) {
    describe(blueprint.id, () => {
      const parsed = parseSkillFile(blueprint.source);

      test("frontmatter name is a valid skill slug", () => {
        expect(parsed.metadata.name).toMatch(SKILL_NAME_PATTERN);
      });

      test("frontmatter has a non-empty description", () => {
        expect(parsed.metadata.description.trim().length).toBeGreaterThan(0);
      });

      test("ships inline coaching", () => {
        expect(blueprint.source).toContain("<!-- guide:");
      });

      test("resource paths are storable and renderable", () => {
        for (const resource of blueprint.resources) {
          expect(isAllowedResourcePath(resource.path)).toBe(true);
          expect(resource.path).toMatch(FILE_TREE_PATH_PATTERN);
        }
      });

      // The blank blueprint is a deliberately empty scaffold — no resources,
      // so there is no folder structure to teach.
      test.if(blueprint.id !== "blank")(
        "teaches a nested references tree",
        () => {
          const hasNestedReference = blueprint.resources.some(
            (resource) =>
              resource.kind === "reference" &&
              resource.path.split("/").length >= 3,
          );
          expect(hasNestedReference).toBe(true);
        },
      );
    });
  }
});
