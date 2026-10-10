import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, test } from "bun:test";

import { queryView } from "@/lib/query-view.logic";

import { addableMembersView } from "./addable-member-select.logic";

const organization = {
  members: [
    {
      userId: "member",
      user: { name: "Member", email: "member@example.test", image: null },
    },
  ],
};

for (const organizationFails of [true, false]) {
  const source = organizationFails ? "organization" : "members";
  test(`keeps a failed ${source} read distinct from addable members`, async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const org = new QueryObserver(client, {
      queryKey: ["org"],
      queryFn: async () => organization,
      enabled: false,
    });
    const members = new QueryObserver(client, {
      queryKey: ["members"],
      queryFn: async (): Promise<{ userId: string }[]> => [],
      enabled: false,
    });
    await org.refetch();
    await members.refetch();
    const failing = organizationFails ? org : members;
    failing.setOptions({
      queryKey: [organizationFails ? "org" : "members"],
      queryFn: async () => {
        throw new Error("Read unavailable");
      },
      enabled: false,
    });
    client.removeQueries({
      queryKey: [organizationFails ? "org" : "members"],
    });
    await failing.refetch();
    expect(
      addableMembersView(
        queryView(org.getCurrentResult()),
        queryView(members.getCurrentResult()),
      ).type,
    ).toBe("error");
    org.destroy();
    members.destroy();
    client.clear();
  });
}

test("waits for both reads before offering organization members", () => {
  expect(addableMembersView({ type: "pending" }, { type: "empty" }).type).toBe(
    "pending",
  );
  expect(addableMembersView({ type: "empty" }, { type: "pending" }).type).toBe(
    "pending",
  );
});

const retry = async () => {
  throw new Error("Retry fixture");
};

test("offers only organization members outside the matter", () => {
  expect(
    addableMembersView(
      { type: "items", items: organization, retry },
      { type: "empty" },
    ),
  ).toEqual({
    type: "items",
    items: [
      {
        email: "member@example.test",
        image: null,
        name: "Member",
        value: "member",
      },
    ],
  });
  expect(
    addableMembersView(
      { type: "items", items: organization, retry },
      { type: "items", items: [{ userId: "member" }], retry },
    ),
  ).toEqual({ type: "empty" });
});

test("keeps cached zero candidates with the refetch notice", () => {
  expect(
    addableMembersView(
      { type: "items", items: organization, retry },
      {
        type: "items",
        items: [{ userId: "member" }],
        retry,
        refetchError: new Error("Read unavailable"),
      },
    ),
  ).toEqual({ type: "items", items: [] });
});
