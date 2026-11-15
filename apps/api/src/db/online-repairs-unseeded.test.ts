import { describe, expect, test } from "bun:test";
import path from "node:path";

import { treeBaseRevision } from "@stll/scripts/src/tree-base-revision";

import { ONLINE_MIGRATION_REPAIRS } from "./online-migrations";
import unseeded from "./online-repairs-unseeded.json";

const repoRoot = path.resolve(import.meta.dir, "../../../..");
const LIST_PATH = "apps/api/src/db/online-repairs-unseeded.json";

/**
 * The repairs `online-repairs-beside-writer.postgres.test.ts` does not run
 * beside a writer yet. A repair added to the registry brings its seed, and
 * seeding one removes it here, so the list only shrinks.
 */
describe("unseeded online repairs", () => {
  test("every entry names a registered repair and states why", () => {
    const registered = new Set(
      ONLINE_MIGRATION_REPAIRS.map(({ name }) => name),
    );
    for (const [name, reason] of Object.entries(unseeded.repairs)) {
      expect(registered.has(name), name).toBe(true);
      expect(reason.trim().length, name).toBeGreaterThan(20);
    }
  });

  test("the list only shrinks from the merge base", () => {
    const revision = treeBaseRevision({ repoRoot });
    const present = Bun.spawnSync(
      ["git", "ls-tree", "--name-only", revision, LIST_PATH],
      { cwd: repoRoot },
    );
    expect(present.exitCode).toBe(0);
    // The introducing change establishes the list.
    if (new TextDecoder().decode(present.stdout).trim() === "") {
      return;
    }
    const prior = Bun.spawnSync(["git", "show", `${revision}:${LIST_PATH}`], {
      cwd: repoRoot,
    });
    expect(prior.exitCode).toBe(0);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(prior.stdout));
    const priorRepairs =
      typeof parsed === "object" &&
      parsed !== null &&
      "repairs" in parsed &&
      typeof parsed.repairs === "object" &&
      parsed.repairs !== null
        ? Object.keys(parsed.repairs)
        : [];
    expect(
      Object.keys(unseeded.repairs).filter(
        (name) => !priorRepairs.includes(name),
      ),
    ).toEqual([]);
  });
});
