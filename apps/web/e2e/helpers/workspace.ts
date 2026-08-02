import type { APIRequestContext } from "@playwright/test";
import { Result, panic } from "better-result";
import { randomUUID } from "node:crypto";

import { apiDelete, apiGet, apiPut } from "./api";

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
        await apiPut(
          request,
          "/workspaces",
          {
            id,
            name,
            filePropertyName: "Documents",
          },
          { invalidates: true },
        );
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
  await apiDelete(request, `/workspaces/${workspaceId}`, { invalidates: true });
};
