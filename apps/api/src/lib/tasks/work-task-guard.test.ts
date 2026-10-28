import { describe, expect, test } from "bun:test";
import path from "node:path";

const API_ROOT = path.resolve(import.meta.dir, "../../..");
const OWNER = "src/lib/tasks/work-task.ts";

/** Direct task-kind queries that intentionally operate on every Legal List entry. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  "src/db/schema/entities.ts":
    "the schema constraint validates every list item type stored as a task entity",
  "src/handlers/lists/items/list.ts":
    "Legal Lists must read facts, issues, requirements, events, and tasks",
  "src/handlers/tasks/assignees/add.ts":
    "the update path locks task entities before list-item eligibility is validated",
  "src/handlers/tasks/assignees/move.ts":
    "the update path locks task entities before list-item eligibility is validated",
  "src/lib/account-deletion-steps.ts":
    "account deletion must clean references from every list item type",
  "src/lib/entity-filters.ts":
    "presentation CASE expressions choose task entity columns; they do not select work",
  "src/lib/tasks/update-task.ts":
    "the shared list-item update path must update every list item type",
  "src/lib/work-obligations/legacy-work-obligation.ts":
    "legacy obligation repair inspects task entities before eligibility is validated",
};

const DIRECT_TASK_KIND = [
  /\beq\([^\n,()]+\.kind\s*,\s*["']task["']\s*\)/gu,
  /\$\{[^}\n]+\.kind\}\s*=\s*'task'/gu,
] as const;

export const directTaskKindLines = (source: string): number[] => {
  const lines = new Set<number>();
  for (const pattern of DIRECT_TASK_KIND) {
    for (const match of source.matchAll(pattern)) {
      lines.add(source.slice(0, match.index).split("\n").length);
    }
  }
  return [...lines].toSorted((left, right) => left - right);
};

const sourceFiles = (): string[] =>
  [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: API_ROOT })]
    .filter((file) => !/\.(?:test|spec|d)\.ts$/u.test(file))
    .toSorted();

describe("work task query ownership", () => {
  test("task-kind queries go through workTask unless every list item is required", async () => {
    const violations: string[] = [];
    const allowlistedMatches: string[] = [];
    for (const file of sourceFiles()) {
      const lines = directTaskKindLines(
        await Bun.file(path.join(API_ROOT, file)).text(),
      );
      if (lines.length === 0 || file === OWNER) {
        continue;
      }
      const rendered = `${file}:${lines.join(",")}`;
      if (file in ALLOWLIST) {
        allowlistedMatches.push(file);
      } else {
        violations.push(rendered);
      }
    }

    expect(violations).toEqual([]);
    expect(allowlistedMatches.toSorted()).toEqual(
      Object.keys(ALLOWLIST).toSorted(),
    );
  });

  test("detects a new direct task-kind filter", () => {
    const fixture = `const predicate = eq(entities.kind, "task");`;
    expect(directTaskKindLines(fixture)).toEqual([1]);
  });
});
