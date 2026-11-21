import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const options = { sourcePath: "apps/api/src/handlers/tasks/assign.ts" };

test("reports inline string schemas on user ID fields", async () => {
  expect(
    await lintSingleRule(
      "no-raw-user-id-schema",
      [
        "const a = v.object({ userId: v.string() });",
        "const b = v.object({ leadUserId: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(128)))) });",
        "const c = v.object({ assigneeUserId: withDescription(v.string(), 'Assignee') });",
        "",
      ].join("\n"),
      options,
    ),
  ).toEqual([1, 2, 3]);
});

test("accepts the shared user ID schemas and unrelated strings", async () => {
  expect(
    await lintSingleRule(
      "no-raw-user-id-schema",
      [
        "const a = v.object({ userId: v.optional(userIdSchema) });",
        "const b = v.object({ toUserId: withDescription(userIdSchema, 'Target') });",
        "const c = v.object({ ownerUserId: v.nullable(resourceIdSchema('user')) });",
        "const d = v.object({ search: v.string(), userIdHint: v.string() });",
        "const e = { userId: session.user.id };",
        "",
      ].join("\n"),
      options,
    ),
  ).toEqual([]);
});

test("contact owner validation recognizes locked membership checks", async () => {
  const owner = "const owner = { originatingAttorneyId: userIdSchema };\n";
  const contactOptions = {
    sourcePath: "apps/api/src/handlers/contacts/create.ts",
  };
  expect(
    await lintSingleRule("no-raw-user-id-schema", owner, contactOptions),
  ).toEqual([1]);
  expect(
    await lintSingleRule(
      "no-raw-user-id-schema",
      `${
        owner
      }await lockOrgUserIdsForAssignment({tx, userIds, organizationId});\n`,
      contactOptions,
    ),
  ).toEqual([]);
});
