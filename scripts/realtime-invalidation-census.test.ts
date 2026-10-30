import { expect, test } from "bun:test";

import { directRealtimeInvalidations } from "./realtime-invalidation-census";

test("realtime invalidations are owned by the refresh scheduler", () => {
  expect(
    directRealtimeInvalidations([
      {
        path: "apps/web/src/lib/workspace-sse.ts",
        source: "queryClient.invalidateQueries({ queryKey });",
      },
    ]),
  ).toEqual(["apps/web/src/lib/workspace-sse.ts"]);
  expect(
    directRealtimeInvalidations([
      {
        path: "apps/web/src/lib/workspaces/realtime-refresh.ts",
        source: "queryClient.invalidateQueries({ queryKey });",
      },
      {
        path: "apps/web/src/lib/workspace-sse.ts",
        source: "realtimeRefresh.refresh(queryKey);",
      },
    ]),
  ).toEqual([]);
});
