import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects bare inferred union and default ownership ID parameters", async () => {
  expect(
    await lintSingleRule(
      "no-unbranded-ownership-id-param",
      'function a(userId: string) {}\nconst b = (workspaceId) => null;\nconst c = (organizationId: SafeId<"organization"> | string) => null;\nfunction d(userId: string = "x") {}\nconst e = ({ workspaceId }: { workspaceId: string }) => null;',
    ),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("accepts branded ID parameters and unrelated strings", async () => {
  expect(
    await lintSingleRule(
      "no-unbranded-ownership-id-param",
      'function a(userId: SafeId<"user">) {}\nconst b = ({ workspaceId }: { workspaceId: SafeId<"workspace"> }) => null;\nfunction c(label: string) {}',
    ),
  ).toEqual([]);
});

test("requires branding in unannotated destructured token and public handlers", async () => {
  expect(
    await lintSingleRule(
      "no-unbranded-ownership-id-param",
      "createSafeTokenHandler(({ userId }) => userId);\ncreateSafePublicHandler(({ organizationId }) => organizationId);\nconst plain = ({ workspaceId }) => workspaceId;",
    ),
  ).toEqual([1, 2, 3]);
});

test("accepts authenticated framework context and contextual execute handlers", async () => {
  expect(
    await lintSingleRule(
      "no-unbranded-ownership-id-param",
      "createSafeHandler(({ userId, workspaceId }) => userId);\ncreateSafeRootHandler(({ organizationId }) => organizationId);\nconst operation = { execute: ({ userId }) => userId };",
    ),
  ).toEqual([]);
});

test("honors configured ID names without retaining default names", async () => {
  expect(
    await lintSingleRule(
      "no-unbranded-ownership-id-param",
      "function custom(tenantId: string) {}\nfunction defaultName(userId: string) {}",
      { ruleOptions: { names: ["tenantId"] } },
    ),
  ).toEqual([1]);
});
