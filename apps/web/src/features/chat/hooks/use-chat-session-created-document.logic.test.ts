import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { invalidateCreatedDocumentQueries } from "./use-chat-session-created-document.logic";

describe("invalidateCreatedDocumentQueries", () => {
  test("invalidates entity and activity caches only for the target matter", async () => {
    const queryClient = new QueryClient();
    const targetEntityRootKey = ["entities", "matter-a"];
    const targetEntityKey = [...targetEntityRootKey, "list"];
    const otherEntityKey = ["entities", "matter-b", "list"];
    const targetActivityRootKey = ["workspaces", "matter-a", "activity"];
    const targetActivityKey = [...targetActivityRootKey, "organization-a"];
    const otherActivityKey = [
      "workspaces",
      "matter-b",
      "activity",
      "organization-a",
    ];
    for (const key of [
      targetEntityKey,
      otherEntityKey,
      targetActivityKey,
      otherActivityKey,
    ]) {
      queryClient.setQueryData(key, { pages: [] });
    }

    await invalidateCreatedDocumentQueries({
      queryClient,
      queryKeys: [targetEntityRootKey, targetActivityRootKey],
    });

    expect(queryClient.getQueryState(targetEntityKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(targetActivityKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(otherEntityKey)?.isInvalidated).toBe(
      false,
    );
    expect(queryClient.getQueryState(otherActivityKey)?.isInvalidated).toBe(
      false,
    );
  });
});
