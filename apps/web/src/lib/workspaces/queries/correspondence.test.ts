import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { correspondenceKeys } from "./correspondence";

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
