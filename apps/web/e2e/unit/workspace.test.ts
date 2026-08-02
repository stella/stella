import { describe, expect, test } from "bun:test";

import { createTestWorkspaceWithOperations } from "../helpers/workspace";

const fileProperty = [{ id: "file-property", content: { type: "file" } }];
const firstView = [{ id: "first-view" }];

describe("test workspace setup", () => {
  test("rolls back every failure after workspace creation", async () => {
    const failureStages = [
      {
        name: "property request",
        properties: async () => await Promise.reject(new Error("properties")),
        views: async () => firstView,
      },
      {
        name: "missing file property",
        properties: async () => [],
        views: async () => firstView,
      },
      {
        name: "view request",
        properties: async () => fileProperty,
        views: async () => await Promise.reject(new Error("views")),
      },
      {
        name: "missing view",
        properties: async () => fileProperty,
        views: async () => [],
      },
    ];

    await Promise.all(
      failureStages.map(async (failure) => {
        let createdId: string | null = null;
        let deletedId: string | null = null;
        const result = createTestWorkspaceWithOperations(
          {
            create: async ({ id }) => {
              createdId = id;
            },
            delete: async (workspaceId) => {
              deletedId = workspaceId;
            },
            properties: failure.properties,
            views: failure.views,
          },
          failure.name,
        );

        const rejection = await result.then(
          () => null,
          (error: unknown) => error,
        );
        expect(rejection).toBeInstanceOf(Error);
        expect(deletedId).toBe(createdId);
      }),
    );
  });
});
