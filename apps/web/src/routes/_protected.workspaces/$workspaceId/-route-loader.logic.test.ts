import { describe, expect, test } from "bun:test";

import { matterRouteView } from "@/lib/workspaces/archived-matters.logic";
import { loadWorkspaceRouteQueries } from "@/routes/_protected.workspaces/$workspaceId/-route-loader.logic";

describe("matter route query startup", () => {
  test("starts every non-blocking query after an active workspace resolves", async () => {
    const starts: string[] = [];

    const result = await loadWorkspaceRouteQueries({
      loadWorkspace: async () => {
        starts.push("workspace");
        return { status: "active" as const };
      },
      shouldStartPrefetches: ({ status }) =>
        matterRouteView(status) === "active",
      startPrefetches: [
        () => {
          starts.push("workflow");
        },
        () => {
          starts.push("views");
        },
        () => {
          starts.push("overview");
        },
        () => {
          starts.push("properties");
        },
      ],
    });

    expect(starts).toEqual([
      "workspace",
      "workflow",
      "views",
      "overview",
      "properties",
    ]);

    expect(result).toEqual({ status: "active" });
  });

  test("does not start active-only prefetches for an archived workspace", async () => {
    const starts: string[] = [];
    const result = await loadWorkspaceRouteQueries({
      loadWorkspace: async () => ({ status: "archived" as const }),
      shouldStartPrefetches: ({ status }) =>
        matterRouteView(status) === "active",
      startPrefetches: [
        () => {
          starts.push("workflow");
        },
        () => {
          starts.push("views");
        },
        () => {
          starts.push("overview");
        },
        () => {
          starts.push("properties");
        },
      ],
    });

    expect(result).toEqual({ status: "archived" });
    expect(starts).toEqual([]);
  });
});

test("renders the matter while metadata warmups are still pending", async () => {
  const metadata = Promise.withResolvers<boolean>();
  let warmed = false;
  const result = loadWorkspaceRouteQueries({
    loadWorkspace: async () => "Matter B",
    shouldStartPrefetches: () => true,
    startPrefetches: [
      () => {
        void metadata.promise.then(() => {
          warmed = true;
          return warmed;
        });
      },
    ],
  });

  expect(await result).toBe("Matter B");
  expect(warmed).toBe(false);
  metadata.resolve(true);
  await metadata.promise;
  expect(warmed).toBe(true);
});
