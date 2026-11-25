import { describe, expect, test } from "bun:test";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";
import { treeBaseRevision } from "@stll/scripts/src/tree-base-revision";

import { REGISTERED_SCHEDULER_TASK_NAMES } from "./registry";
import { RETIRED_SCHEDULER_TASK_NAMES } from "./retired-tasks";
import ledger from "./task-names.json";

const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const LEDGER_PATH = "apps/api/src/lib/scheduler/task-names.json";

const sorted = (names: Iterable<string>) =>
  [...names].toSorted(compareCodeUnit);

/**
 * Every scheduler task name any build has declared. Registration retires only
 * names in `RETIRED_SCHEDULER_TASK_NAMES`, so a task removed from the registry
 * has to be listed there; this ledger is what makes the removal visible.
 */
describe("scheduler task name ledger", () => {
  test("a task is registered or retired, never both", () => {
    expect(
      sorted(REGISTERED_SCHEDULER_TASK_NAMES).filter((name) =>
        RETIRED_SCHEDULER_TASK_NAMES.has(name),
      ),
    ).toEqual([]);
  });

  test("the ledger is exactly the registered and retired names", () => {
    expect(ledger.names).toEqual(
      sorted([
        ...REGISTERED_SCHEDULER_TASK_NAMES,
        ...RETIRED_SCHEDULER_TASK_NAMES,
      ]),
    );
  });

  test("the ledger only grows from the merge base", () => {
    const revision = treeBaseRevision({ repoRoot });
    const present = Bun.spawnSync(
      ["git", "ls-tree", "--name-only", revision, LEDGER_PATH],
      { cwd: repoRoot },
    );
    expect(present.exitCode).toBe(0);
    // The introducing change establishes the ledger.
    if (new TextDecoder().decode(present.stdout).trim() === "") {
      return;
    }
    const prior = Bun.spawnSync(["git", "show", `${revision}:${LEDGER_PATH}`], {
      cwd: repoRoot,
    });
    expect(prior.exitCode).toBe(0);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(prior.stdout));
    const priorNames =
      typeof parsed === "object" &&
      parsed !== null &&
      "names" in parsed &&
      Array.isArray(parsed.names)
        ? parsed.names.filter(
            (name): name is string => typeof name === "string",
          )
        : [];
    expect(priorNames.filter((name) => !ledger.names.includes(name))).toEqual(
      [],
    );
  });
});
