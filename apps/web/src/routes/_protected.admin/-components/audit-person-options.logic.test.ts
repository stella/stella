import { expect, test } from "bun:test";

import { auditPersonOptions } from "./audit-person-options.logic";

const member = (userId: string, name: string) => ({
  userId,
  name,
  email: `${userId}@example.com`,
  image: null,
});

test("a person who left the organization stays choosable from the entries they appear in", () => {
  expect(
    auditPersonOptions({
      members: [member("u-1", "First Member")],
      entries: [
        { userId: "u-1", actor: "First Member", performerType: "user" },
        { userId: "u-2", actor: "u-2", performerType: "user" },
        { userId: "u-2", actor: "u-2", performerType: "agent" },
      ],
      selected: null,
    }),
  ).toEqual([
    member("u-1", "First Member"),
    { userId: "u-2", name: "u-2", email: null, image: null },
  ]);
});

test("background services are not people", () => {
  expect(
    auditPersonOptions({
      members: [],
      entries: [
        {
          userId: "system:reminders",
          actor: "Reminders",
          performerType: "service",
        },
      ],
      selected: null,
    }),
  ).toEqual([]);
});

test("the chosen person stays listed when no member or loaded entry names them", () => {
  const departed = { userId: "u-9", name: "u-9", email: null, image: null };
  expect(
    auditPersonOptions({
      members: [member("u-1", "First Member")],
      entries: [],
      selected: departed,
    }),
  ).toEqual([member("u-1", "First Member"), departed]);
  expect(
    auditPersonOptions({
      members: [member("u-1", "First Member")],
      entries: [],
      selected: member("u-1", "First Member"),
    }),
  ).toEqual([member("u-1", "First Member")]);
});

test("before the first page loads, members and the chosen person are still offered", () => {
  const departed = { userId: "u-9", name: "u-9", email: null, image: null };
  expect(
    auditPersonOptions({
      members: [member("u-1", "First Member")],
      entries: undefined,
      selected: departed,
    }),
  ).toEqual([member("u-1", "First Member"), departed]);
});
