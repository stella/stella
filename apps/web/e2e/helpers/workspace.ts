import type { APIRequestContext } from "@playwright/test";
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

const isFileProperty = (
  p: WorkspaceReadProperty,
): p is FileProperty & WorkspaceReadProperty => p.content.type === "file";

export const createTestWorkspace = async (
  request: APIRequestContext,
  label = "e2e",
): Promise<TestWorkspace> => {
  const workspaceId = randomUUID();

  await apiPut(
    request,
    "/workspaces",
    {
      id: workspaceId,
      name: `${label}-${workspaceId.slice(0, 8)}`,
      filePropertyName: "Documents",
    },
    { invalidates: true },
  );

  // Find the file property and the first view, both auto-created on workspace creation.
  const properties = await apiGet<WorkspaceReadProperty[]>(
    request,
    `/properties/${workspaceId}`,
  );
  const fileProperty = properties.find(isFileProperty);
  if (!fileProperty) {
    throw new Error(
      `workspace ${workspaceId} has no file property: ${JSON.stringify(properties)}`,
    );
  }

  const views = await apiGet<ViewListItem[]>(request, `/views/${workspaceId}`);
  const firstView = views.at(0);
  if (!firstView) {
    throw new Error(`workspace ${workspaceId} has no views`);
  }

  return {
    id: workspaceId,
    filePropertyId: fileProperty.id,
    viewId: firstView.id,
  };
};

export const deleteTestWorkspace = async (
  request: APIRequestContext,
  workspaceId: string,
): Promise<void> => {
  await apiDelete(request, `/workspaces/${workspaceId}`, { invalidates: true });
};
