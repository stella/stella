import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const IMPORTS = [
  'import { Select, SelectItem } from "@stll/ui/select";',
  'import { UserIdentity } from "@/components/user-avatar";',
].join("\n");

test("rejects a Select whose items are valued by a user id", async () => {
  expect(
    await lintSingleRule(
      "no-person-select",
      `${IMPORTS}
const byUserId = <Select>{members.map((m) => <SelectItem value={m.userId}>{m.name}</SelectItem>)}</Select>;
const byUser = <Select>{members.map((m) => <SelectItem value={m.user.id}>{m.name}</SelectItem>)}</Select>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([3, 4]);
});

test("rejects a user id behind a fallback, a conditional, a cast or a conversion", async () => {
  expect(
    await lintSingleRule(
      "no-person-select",
      `${IMPORTS}
const fallback = <Select>{members.map((m) => <SelectItem value={m.user?.id ?? ""}>{m.name}</SelectItem>)}</Select>;
const conditional = <Select>{members.map((m) => <SelectItem value={m.active ? m.userId : ""}>{m.name}</SelectItem>)}</Select>;
const cast = <Select>{members.map((m) => <SelectItem value={m.userId as string}>{m.name}</SelectItem>)}</Select>;
const converted = <Select>{members.map((m) => <SelectItem value={String(m.userId)}>{m.name}</SelectItem>)}</Select>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([3, 4, 5, 6]);
});

test("rejects a Select that renders a user identity", async () => {
  expect(
    await lintSingleRule(
      "no-person-select",
      `${IMPORTS}
const identity = <Select>{members.map((m) => <SelectItem value={m}><UserIdentity name={m.name} /></SelectItem>)}</Select>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([3]);
});

test("accepts a Select over values that are not people", async () => {
  expect(
    await lintSingleRule(
      "no-person-select",
      `${IMPORTS}
const language = <Select>{codes.map((code) => <SelectItem value={code}>{code}</SelectItem>)}</Select>;
const beside = <div><UserIdentity name="Eva" /><Select><SelectItem value={role.id}>{role.name}</SelectItem></Select></div>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("ignores a Select that is not the design-system one", async () => {
  expect(
    await lintSingleRule(
      "no-person-select",
      `import { Select, SelectItem } from "./local-select";
const local = <Select>{members.map((m) => <SelectItem value={m.userId}>{m.name}</SelectItem>)}</Select>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});
