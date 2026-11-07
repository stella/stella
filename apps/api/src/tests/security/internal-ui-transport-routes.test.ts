import { expect, test } from "bun:test";

import { INTERNAL_UI_TRANSPORT_ROUTES } from "@stll/api-contract/internal-ui-transport";

import { apiRoutes } from "@/api/api-routes";

test("internal UI dispatches name their mounted method, path, and reason", () => {
  for (const route of Object.values(INTERNAL_UI_TRANSPORT_ROUTES)) {
    const matches = apiRoutes.filter(
      (mounted) =>
        mounted.method === route.method && mounted.path === route.path,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.definition.config["mcp"]).toEqual({
      type: "internal",
      reason: route.reason,
    });
  }
});
