import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects raw Avatar imports in user surfaces", async () => {
  expect(
    await lintSingleRule(
      "no-raw-user-avatar-primitive",
      'import { Avatar, AvatarImage as Image } from "@stll/ui/avatar";',
      { sourcePath: "apps/web/src/components/example.tsx" },
    ),
  ).toEqual([1, 1]);
});

test("rejects grouped primitive imports in user surfaces", async () => {
  expect(
    await lintSingleRule(
      "no-raw-user-avatar-primitive",
      'import { AvatarFallback } from "@stll/ui/components/avatar";',
      { sourcePath: "apps/web/src/components/example.tsx" },
    ),
  ).toEqual([1]);
});

test("accepts the shared user identity surface", async () => {
  expect(
    await lintSingleRule(
      "no-raw-user-avatar-primitive",
      'import { UserIdentityAvatar, UserIdentity } from "@/components/user-avatar";',
      { sourcePath: "apps/web/src/components/example.tsx" },
    ),
  ).toEqual([]);
});

test("accepts organization identity in its explicit exception", async () => {
  expect(
    await lintSingleRule(
      "no-raw-user-avatar-primitive",
      'import { Avatar } from "@stll/ui/avatar";',
      { sourcePath: "apps/web/src/routes/auth/organization.tsx" },
    ),
  ).toEqual([]);
});

test("accepts the primitive outside user app surfaces", async () => {
  expect(
    await lintSingleRule(
      "no-raw-user-avatar-primitive",
      'import { Avatar } from "@stll/ui/avatar";',
      { sourcePath: "packages/ui/src/example.tsx" },
    ),
  ).toEqual([]);
});

test("keeps organization avatar imports restricted outside their owner", async () => {
  expect(
    await lintSingleRule(
      "no-raw-user-avatar-primitive",
      'import { Avatar } from "@stll/ui/avatar";',
      { sourcePath: "apps/web/src/routes/settings/organization.tsx" },
    ),
  ).toEqual([1]);
});
