import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import {
  correspondenceKeys,
  correspondenceAddressState,
  uniqueCorrespondenceAddresses,
} from "./correspondence";

describe("correspondence query invalidation", () => {
  test("refreshes the list, record, and address in one matter without touching another", async () => {
    const queryClient = new QueryClient();
    const ownKeys = [
      correspondenceKeys.infinite("matter-a", 50),
      correspondenceKeys.byId("matter-a", "message-a"),
      correspondenceKeys.address("matter-a"),
    ];
    const otherKey = correspondenceKeys.infinite("matter-b", 50);
    for (const key of [...ownKeys, otherKey]) {
      queryClient.setQueryData(key, { value: true });
    }

    await queryClient.invalidateQueries({
      queryKey: correspondenceKeys.all("matter-a"),
    });

    for (const key of ownKeys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });
});

test("recipient labels keep the first entry for each email address", () => {
  expect(
    uniqueCorrespondenceAddresses([
      { address: "Office@example.test", name: "Office" },
      { address: "office@example.test", name: "Duplicate" },
      { address: "client@example.test", name: null },
    ]),
  ).toEqual([
    { address: "Office@example.test", name: "Office" },
    { address: "client@example.test", name: null },
  ]);
});

describe("matter email address setup", () => {
  test("an unconfigured domain remains distinct from an address waiting to be created", () => {
    const unconfigured = {
      address: null,
      setupHint: "Inbound mail domain is not configured",
    } satisfies Parameters<typeof correspondenceAddressState>[0];
    const readyToCreate = {
      address: null,
      setupHint: null,
    } satisfies Parameters<typeof correspondenceAddressState>[0];

    expect(unconfigured.address).toBe(readyToCreate.address);
    expect(correspondenceAddressState(unconfigured)).toEqual({
      status: "unconfigured",
    });
    expect(correspondenceAddressState(readyToCreate)).toEqual({
      status: "configured",
      address: null,
    });
  });

  test("a configured active address remains available for copying and rotation", () => {
    const active = {
      address: "matter-token@mail.example",
      setupHint: null,
    } satisfies Parameters<typeof correspondenceAddressState>[0];
    expect(correspondenceAddressState(active)).toEqual({
      status: "configured",
      address: active.address,
    });
  });
});
