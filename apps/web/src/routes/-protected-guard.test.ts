import { QueryClient } from "@tanstack/react-query";
import { expect, spyOn, test } from "bun:test";

import { roleOptions } from "@/lib/auth-queries";
import { prefetchProtectedShell } from "@/routes/-protected-guard";

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
