import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("contact owner validation recognizes locked membership checks", async () => {
  const owner = "const owner = { originatingAttorneyId: tUserId };\n";
  const options = { sourcePath: "apps/api/src/handlers/contacts/create.ts" };
  expect(await lintSingleRule("no-raw-user-id-schema", owner, options)).toEqual(
    [1],
  );
  expect(
    await lintSingleRule(
      "no-raw-user-id-schema",
      `${
        owner
      }await lockOrgUserIdsForAssignment({tx, userIds, organizationId});\n`,
      options,
    ),
  ).toEqual([]);
});
