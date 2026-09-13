import { expect, type APIRequestContext } from "@playwright/test";
import { Result, panic } from "better-result";
import { randomUUID } from "node:crypto";

import { apiDeleteStatus, apiGet, apiPut } from "./api";

type FileProperty = { id: string };

export type TestWorkspace = {
  id: string;
  filePropertyId: string;
  viewId: string;
};

type WorkspaceReadProperty = {
  id: string;
  content: { type: string };
};

type ViewListItem = { id: string };

type TestWorkspaceOperations = {
  create: (workspace: { id: string; name: string }) => Promise<void>;
  delete: (workspaceId: string) => Promise<void>;
  properties: (workspaceId: string) => Promise<WorkspaceReadProperty[]>;
  views: (workspaceId: string) => Promise<ViewListItem[]>;
};

const isFileProperty = (
  p: WorkspaceReadProperty,
): p is FileProperty & WorkspaceReadProperty => p.content.type === "file";

export const createTestWorkspace = async (
  request: APIRequestContext,
  label = "e2e",
): Promise<TestWorkspace> =>
  await createTestWorkspaceWithOperations(
    {
      create: async ({ id, name }) => {
        await apiPut(request, "/workspaces", {
          id,
          name,
          filePropertyName: "Documents",
        });
      },
      delete: async (workspaceId) => {
        await deleteTestWorkspace(request, workspaceId);
      },
      properties: async (workspaceId) =>
        await apiGet<WorkspaceReadProperty[]>(
          request,
          `/properties/${workspaceId}`,
        ),
      views: async (workspaceId) =>
        await apiGet<ViewListItem[]>(request, `/views/${workspaceId}`),
    },
    label,
  );

export const createTestWorkspaceWithOperations = async (
  operations: TestWorkspaceOperations,
  label = "e2e",
): Promise<TestWorkspace> => {
  const workspaceId = randomUUID();

  await operations.create({
    id: workspaceId,
    name: `${label}-${workspaceId.slice(0, 8)}`,
  });

  const initialized = await Result.tryPromise(async () => {
    // Find the file property and first view, both auto-created with the workspace.
    const properties = await operations.properties(workspaceId);
    const fileProperty = properties.find(isFileProperty);
    if (!fileProperty) {
      panic(
        `workspace ${workspaceId} has no file property: ${JSON.stringify(properties)}`,
      );
    }

    const views = await operations.views(workspaceId);
    const firstView = views.at(0);
    if (!firstView) {
      panic(`workspace ${workspaceId} has no views`);
    }

    return {
      id: workspaceId,
      filePropertyId: fileProperty.id,
      viewId: firstView.id,
    };
  });

  if (Result.isOk(initialized)) {
    return initialized.value;
  }

  const cleanup = await Result.tryPromise(async () => {
    await operations.delete(workspaceId);
  });
  if (Result.isError(cleanup)) {
    throw new AggregateError(
      [initialized.error.cause, cleanup.error.cause],
      `workspace ${workspaceId} setup and rollback both failed`,
    );
  }

  throw initialized.error.cause;
};

export const deleteTestWorkspace = async (
  request: APIRequestContext,
  workspaceId: string,
): Promise<void> => {
  const path = `/workspaces/${workspaceId}`;
  const outcome: { failure: Error | null } = { failure: null };
  await expect
    .poll(
      async () => {
        const attempt = await Result.tryPromise(
          async () => await apiDeleteStatus(request, path),
        );
        // expect.poll retries thrown errors too; return before surfacing failures.
        if (Result.isError(attempt)) {
          outcome.failure = attempt.error;
          return true;
        }
        const result = attempt.value;
        if (
          result.status === 404 ||
          (result.status >= 200 && result.status < 300)
        ) {
          return true;
        }
        if (
          result.status === 409 &&
          result.body.includes(
            "Wait for document processing or another deletion attempt to finish",
          )
        ) {
          return false;
        }
        outcome.failure = new Error(
          `DELETE ${path} -> ${String(result.status)}: ${result.body}`,
        );
        return true;
      },
      { timeout: 30_000, intervals: [250, 500, 1000, 2000] },
    )
    .toBe(true);
  if (outcome.failure !== null) {
    throw outcome.failure;
  }
};
