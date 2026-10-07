import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects same-name siblings through wrappers and member expressions", async () => {
  expect(
    await lintSingleRule(
      "no-hand-rolled-user-identity",
      "const a = <div><UserIdentityAvatar name={name} /><span>{name}</span></div>;\nconst b = <div><Tooltip><UserIdentityAvatar name={user.name} /></Tooltip><span>{user.name}</span></div>;",
      { sourcePath: "apps/web/src/components/identity.tsx" },
    ),
  ).toEqual([1, 2]);
});

test("reports each paired avatar once despite nested ancestors", async () => {
  expect(
    await lintSingleRule(
      "no-hand-rolled-user-identity",
      "const a = <div><section><UserIdentityAvatar name={user.name} /><span>{user.name}</span></section><span>{user.name}</span></div>;",
      { sourcePath: "apps/web/src/components/identity.tsx" },
    ),
  ).toEqual([1]);
});

test("accepts shared identity avatar-only different and transformed labels", async () => {
  expect(
    await lintSingleRule(
      "no-hand-rolled-user-identity",
      "const a = <UserIdentity name={user.name} />;\nconst b = <UserIdentityAvatar name={user.name} />;\nconst c = <div><UserIdentityAvatar name={user.name} /><span>{other.name}</span></div>;\nconst d = <div><UserIdentityAvatar name={user.name} /><span>{user.name.toUpperCase()}</span></div>;",
      { sourcePath: "apps/web/src/components/identity.tsx" },
    ),
  ).toEqual([]);
});

test("allows a tooltip-only label rather than a visible sibling", async () => {
  expect(
    await lintSingleRule(
      "no-hand-rolled-user-identity",
      "const a = <TooltipRoot><TooltipTrigger><UserIdentityAvatar name={user.name} /></TooltipTrigger><TooltipPopup>{user.name}</TooltipPopup></TooltipRoot>;",
      { sourcePath: "apps/web/src/components/identity.tsx" },
    ),
  ).toEqual([]);
});

test("does not enforce web identity composition in unrelated packages", async () => {
  expect(
    await lintSingleRule(
      "no-hand-rolled-user-identity",
      "const a = <div><UserIdentityAvatar name={name} /><span>{name}</span></div>;",
      { sourcePath: "packages/other/src/identity.tsx" },
    ),
  ).toEqual([]);
});
