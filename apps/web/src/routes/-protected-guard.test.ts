import { QueryClient } from "@tanstack/react-query";
import { expect, spyOn, test } from "bun:test";

import { roleOptions } from "@/lib/auth-queries";
import { aiAvailabilityOptions } from "@/lib/organization/ai-config-queries";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import {
  prefetchProtectedShell,
  startSignedInShellRequests,
} from "@/routes/-protected-guard";

test("the shared shell warms the member role without fetching route-owned settings", async () => {
  const queryClient = new QueryClient();
  const query = spyOn(queryClient, "query").mockResolvedValue("owner");
  const context = {
    queryClient,
    user: {
      id: "user-fixture",
      activeOrganizationId: "org-fixture",
      name: undefined,
      email: "member@example.test",
      image: null,
      preferredName: null,
      timezoneId: "UTC",
      wordEditShortcut: null,
    },
  };
  try {
    await prefetchProtectedShell({ context });
    expect(query.mock.calls.map(([options]) => options.queryKey)).toEqual([
      roleOptions.queryKey,
    ]);
  } finally {
    query.mockRestore();
    queryClient.clear();
  }
});

test("the signed-in guard starts the workspace navigation with the shell's first wave, without waiting on it", () => {
  const queryClient = new QueryClient();
  const query = spyOn(queryClient, "query").mockResolvedValue(undefined);
  try {
    // Synchronous: the guard has started both requests without awaiting any.
    startSignedInShellRequests({
      queryClient,
      organizationId: "org-fixture",
      userId: "user-fixture",
    });
    expect(query.mock.calls.map(([options]) => options.queryKey)).toEqual([
      aiAvailabilityOptions({ organizationId: "org-fixture" }).queryKey,
      workspacesNavigationOptions({
        userId: "user-fixture",
        organizationId: "org-fixture",
      }).queryKey,
    ]);
  } finally {
    query.mockRestore();
    queryClient.clear();
  }
});
