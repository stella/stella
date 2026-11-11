import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import { roles } from "@stll/permissions";

const MIGRATION = path.resolve(
  import.meta.dir,
  "../../../drizzle/20261111160200_conflict_checks/migration.sql",
);

// The routines that read across matter walls admit the roles listed in their
// SQL. Bind that list to the permission grants, so a role that gains or loses
// `conflictCheck:run` cannot keep or miss the routines' admission silently.
test("the conflict routines admit exactly the roles that run conflict checks", () => {
  const routines = [
    ...readFileSync(MIGRATION, "utf-8").matchAll(
      /CREATE FUNCTION[\s\S]*?\$\$;/gu,
    ),
  ].map((match) => match[0]);
  expect(routines).toHaveLength(2);
  const admitted = routines.map((routine) =>
    [...routine.matchAll(/m\.role IN \(([^)]*)\)/gu)].map((match) =>
      [...(match[1] ?? "").matchAll(/'([a-z]+)'/gu)]
        .map((role) => role[1] ?? "")
        .toSorted((left, right) => (left < right ? -1 : 1)),
    ),
  );
  const runners = ORGANIZATION_ROLE_NAMES.filter(
    (role) => roles[role].authorize({ conflictCheck: ["run"] }).success,
  ).toSorted((left, right) => (left < right ? -1 : 1));
  for (const routineRoles of admitted) {
    expect(routineRoles).toEqual([runners]);
  }
});
