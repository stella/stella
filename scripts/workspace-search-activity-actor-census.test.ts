import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  inspectWorkspaceSearchActivityActorSource,
  readWorkspaceSearchActivityActorInventory,
} from "./workspace-search-activity-actor-census";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

describe("workspace search actor constructor census", () => {
  const owner = "apps/api/src/lib/db/recovery-bookkeeping/search.ts";

  test("the neutral actor contract has exactly one production constructor caller", async () => {
    const inventory =
      await readWorkspaceSearchActivityActorInventory(REPO_ROOT);
    expect(inventory).toEqual({
      importers: [owner],
      callSites: [{ file: owner }],
    });
  });

  test("rejects constructor calls outside the search bookkeeping owner", () => {
    expect(() =>
      inspectWorkspaceSearchActivityActorSource(
        "apps/api/src/lib/unowned-search-actor.ts",
        `import { createWorkspaceSearchActivityActor } from "@/api/lib/db/workspace-search-activity-actor";
        createWorkspaceSearchActivityActor();`,
      ),
    ).toThrow("outside its owner");
  });

  test.each([
    [
      "@/api/lib/db/../db/workspace-search-activity-actor",
      "apps/api/src/lib/unowned-search-actor.ts",
    ],
    [
      "../db/../db/workspace-search-activity-actor",
      "apps/api/src/lib/other/unowned-search-actor.ts",
    ],
  ])("resolves normalized constructor imports %s", (specifier, file) => {
    expect(() =>
      inspectWorkspaceSearchActivityActorSource(
        file,
        `import { createWorkspaceSearchActivityActor } from "${specifier}";
        createWorkspaceSearchActivityActor();`,
      ),
    ).toThrow("outside its owner");
  });

  test("rejects a constructor escape beside the owning direct call", () => {
    expect(() =>
      inspectWorkspaceSearchActivityActorSource(
        owner,
        `import { createWorkspaceSearchActivityActor as createActor } from "@/api/lib/db/workspace-search-activity-actor";
        createActor();
        consume(createActor);`,
      ),
    ).toThrow("only as a direct call or const alias");
  });

  test("type-only contract imports do not count as constructor use", () => {
    expect(
      inspectWorkspaceSearchActivityActorSource(
        "apps/api/src/db/org-scope.ts",
        `import type { WorkspaceSearchActivityActor } from "@/api/lib/db/workspace-search-activity-actor";
        type Actor = WorkspaceSearchActivityActor;`,
      ),
    ).toEqual({ imported: false, callSites: [] });
  });
});
