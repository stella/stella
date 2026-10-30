import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "bun:test";

import { getOrganizationCreationOwner } from "@/lib/organization/creation-state";
import { toSafeId } from "@/lib/safe-id";

test("unfinished creation is retained only within its account and browser client", () => {
  const client = new QueryClient();
  const otherClient = new QueryClient();
  const account = toSafeId<"user">("creation-owner");
  const otherAccount = toSafeId<"user">("other-creation-owner");
  const original = getOrganizationCreationOwner(client, account);
  original.setName("  Original firm  ");
  const intent = original.begin(() => "original-key");
  expect(intent).toEqual({
    name: "  Original firm  ",
    idempotencyKey: "original-key",
  });
  const reopened = getOrganizationCreationOwner(client, account);
  expect(reopened).toBe(original);
  expect(reopened.begin(() => "duplicate-key")).toBeNull();
  expect(reopened.state.getState()).toEqual({ status: "creating", intent });
  for (const isolated of [
    getOrganizationCreationOwner(client, otherAccount),
    getOrganizationCreationOwner(otherClient, account),
    getOrganizationCreationOwner(otherClient, otherAccount),
  ]) {
    expect(isolated).not.toBe(original);
    expect(isolated.state.getState()).toEqual({ status: "draft", name: "" });
  }
});
