import { request as playwrightRequest } from "@playwright/test";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  createTestWorkspaceWithOperations,
  deleteTestWorkspace,
} from "../helpers/workspace";

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

const workspaceId = "00000000-0000-4000-8000-000000000001";
const deletePath = `/v1/workspaces/${workspaceId}`;
const transientConflict =
  "Wait for document processing or another deletion attempt to finish";

describe("deleteTestWorkspace", () => {
  test("retries the documented transient conflict until deletion succeeds", async () => {
    const responses = [
      { status: 409, body: transientConflict },
      { status: 204, body: "" },
    ];
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(`${request.method} ${new URL(request.url).pathname}`);
        const response = responses.shift() ?? { status: 204, body: "" };
        return new Response(response.body, { status: response.status });
      },
    });
    const apiRequest = await playwrightRequest.newContext();
    const originalDelete = apiRequest.delete.bind(apiRequest);
    apiRequest.delete = async (url, options) =>
      await originalDelete(
        new URL(new URL(url).pathname, server.url).href,
        options,
      );

    try {
      await deleteTestWorkspace(apiRequest, workspaceId);
      expect(requests).toEqual([`DELETE ${deletePath}`, `DELETE ${deletePath}`]);
    } finally {
      await apiRequest.dispose();
      await server.stop();
    }
  });

  test("treats an already deleted workspace as success", async () => {
    const responses = [{ status: 404, body: "Not found" }];
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(`${request.method} ${new URL(request.url).pathname}`);
        const response = responses.shift() ?? { status: 204, body: "" };
        return new Response(response.body, { status: response.status });
      },
    });
    const apiRequest = await playwrightRequest.newContext();
    const originalDelete = apiRequest.delete.bind(apiRequest);
    apiRequest.delete = async (url, options) =>
      await originalDelete(
        new URL(new URL(url).pathname, server.url).href,
        options,
      );

    try {
      await deleteTestWorkspace(apiRequest, workspaceId);
      expect(requests).toEqual([`DELETE ${deletePath}`]);
    } finally {
      await apiRequest.dispose();
      await server.stop();
    }
  });

  test("fails immediately outside the documented retry boundary", async () => {
    for (const response of [
      { status: 409, body: "Another conflict" },
      { status: 403, body: "Forbidden" },
      { status: 500, body: "Server error" },
    ]) {
      const requests: string[] = [];
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          requests.push(`${request.method} ${new URL(request.url).pathname}`);
          return new Response(response.body, { status: response.status });
        },
      });
      const apiRequest = await playwrightRequest.newContext();
      const originalDelete = apiRequest.delete.bind(apiRequest);
      apiRequest.delete = async (url, options) =>
        await originalDelete(
          new URL(new URL(url).pathname, server.url).href,
          options,
        );

      try {
        const result = await Result.tryPromise(
          async () => await deleteTestWorkspace(apiRequest, workspaceId),
        );
        expect(Result.isError(result)).toBe(true);
        if (Result.isError(result)) {
          expect(result.error.cause).toEqual(
            new Error(
              `DELETE /workspaces/${workspaceId} -> ${response.status}: ${response.body}`,
            ),
          );
        }
        expect(requests).toHaveLength(1);
      } finally {
        await apiRequest.dispose();
        await server.stop();
      }
    }
  });
});
