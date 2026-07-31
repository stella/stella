import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities.logic";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

import { invalidateCreatedDocumentQueries } from "./use-chat-session-created-document.logic";

describe("invalidateCreatedDocumentQueries", () => {
  test("invalidates entity and activity caches only for the target matter", async () => {
    const queryClient = new QueryClient();
    const targetEntityKey = [...entitiesKeys.all("matter-a"), "list"];
    const otherEntityKey = [...entitiesKeys.all("matter-b"), "list"];
    const targetActivityKey = workspacesKeys.overviewActivity(
      "organization-a",
      "matter-a",
      "all",
    );
    const otherActivityKey = workspacesKeys.overviewActivity(
      "organization-a",
      "matter-b",
      "all",
    );
    for (const key of [
      targetEntityKey,
      otherEntityKey,
      targetActivityKey,
      otherActivityKey,
    ]) {
      queryClient.setQueryData(key, { pages: [] });
    }

    await invalidateCreatedDocumentQueries({
      matterId: "matter-a",
      queryClient,
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
