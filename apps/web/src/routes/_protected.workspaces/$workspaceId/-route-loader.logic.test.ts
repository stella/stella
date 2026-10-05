import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { loadWorkspaceRouteQueries } from "@/routes/_protected.workspaces/$workspaceId/-route-loader.logic";

describe("matter route query startup", () => {
  test("waits for first-render reads while starting all queries in parallel", async () => {
    const workspace = Promise.withResolvers<string>();
    const members = Promise.withResolvers<unknown>();
    const parties = Promise.withResolvers<unknown>();
    const workflow = Promise.withResolvers<unknown>();
    const starts: string[] = [];
    const result = loadWorkspaceRouteQueries({
      loadWorkspace: async () => {
        starts.push("workspace");
        return await workspace.promise;
      },
      loadFirstRenderQueries: [
        () => {
          starts.push("members");
          return members.promise;
        },
        () => {
          starts.push("parties");
          return parties.promise;
        },
        () => {
          starts.push("workflow");
          return workflow.promise;
        },
      ],
      startPrefetches: [() => starts.push("views")],
    });
    expect(starts).toEqual([
      "workspace",
      "members",
      "parties",
      "workflow",
      "views",
    ]);
    workspace.resolve("Matter B");
    members.resolve([]);
    parties.resolve([]);
    expect(await Promise.race([result, Promise.resolve("waiting")])).toBe(
      "waiting",
    );
    workflow.resolve({ running: false });
    expect(await result).toBe("Matter B");
  });

  test("propagates first-render read failures", async () => {
    const result = loadWorkspaceRouteQueries({
      loadWorkspace: async () => "Matter B",
      loadFirstRenderQueries: [
        async () => {
          throw new Error("Workflow unavailable");
        },
      ],
      startPrefetches: [],
    });
    expect(await rejectionOf(result)).toEqual(
      new Error("Workflow unavailable"),
    );
  });

  test("starts every non-blocking query before the workspace query resolves", async () => {
    const workspace = Promise.withResolvers<string>();
    const starts: string[] = [];

    const result = loadWorkspaceRouteQueries({
      loadWorkspace: async () => {
        starts.push("workspace");
        return await workspace.promise;
      },
      loadFirstRenderQueries: [],
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
