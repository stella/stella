import { describe, expect, test } from "bun:test";

import { matterRouteView } from "@/lib/workspaces/archived-matters.logic";
import { loadWorkspaceRouteQueries } from "@/routes/_protected.workspaces/$workspaceId/-route-loader.logic";

type Matter = { status: "active" | "archived" };

const recordingPrefetches = (starts: string[]) =>
  ["workflow", "views", "overview", "properties"].map((name) => () => {
    starts.push(name);
  });

const isActive = ({ status }: Matter) => matterRouteView(status) === "active";

describe("matter route query startup", () => {
  test("starts every non-blocking query before the workspace query resolves", async () => {
    const workspace = Promise.withResolvers<Matter>();
    const starts: string[] = [];

    const result = loadWorkspaceRouteQueries({
      loadWorkspace: async () => {
        starts.push("workspace");
        return await workspace.promise;
      },
      isActive,
      knownInactive: false,
      startPrefetches: recordingPrefetches(starts),
    });

    expect(starts).toEqual([
      "workspace",
      "workflow",
      "views",
      "overview",
      "properties",
    ]);

    workspace.resolve({ status: "active" });
    expect(await result).toEqual({ status: "active" });
  });

  test("a matter known to be archived starts no active-only query", async () => {
    const starts: string[] = [];
    const result = await loadWorkspaceRouteQueries({
      loadWorkspace: async () =>
        await Promise.resolve<Matter>({ status: "archived" }),
      isActive,
      knownInactive: true,
      startPrefetches: recordingPrefetches(starts),
    });

    expect(result).toEqual({ status: "archived" });
    expect(starts).toEqual([]);
  });

  test("a matter known to be archived that loads active again starts them after it loads", async () => {
    const workspace = Promise.withResolvers<Matter>();
    const starts: string[] = [];
    const result = loadWorkspaceRouteQueries({
      loadWorkspace: async () => await workspace.promise,
      isActive,
      knownInactive: true,
      startPrefetches: recordingPrefetches(starts),
    });

    expect(starts).toEqual([]);
    workspace.resolve({ status: "active" });
    expect(await result).toEqual({ status: "active" });
    expect(starts).toEqual(["workflow", "views", "overview", "properties"]);
  });
});

test("renders the matter while metadata warmups are still pending", async () => {
  const metadata = Promise.withResolvers<boolean>();
  let warmed = false;
  const result = loadWorkspaceRouteQueries({
    loadWorkspace: async () => "Matter B",
    isActive: () => true,
    knownInactive: false,
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
