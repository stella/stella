import { describe, expect, test } from "bun:test";

import { loadWorkspaceRouteQueries } from "@/routes/_protected.workspaces/$workspaceId/-route-loader.logic";

describe("matter route query startup", () => {
  test("starts every non-blocking query before the workspace query resolves", async () => {
    const workspace = Promise.withResolvers<string>();
    const starts: string[] = [];

    const result = loadWorkspaceRouteQueries({
      loadWorkspace: async () => {
        starts.push("workspace");
        return await workspace.promise;
      },
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

    workspace.resolve("Matter B");
    expect(await result).toBe("Matter B");
  });
});

test("renders the matter while metadata warmups are still pending", async () => {
  const metadata = Promise.withResolvers<boolean>();
  let warmed = false;
  const result = loadWorkspaceRouteQueries({
    loadWorkspace: async () => "Matter B",
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
