import type { APIRequestContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { apiGet, apiUploadDocx } from "./api";
import type { TestWorkspace } from "./workspace";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_PATH = path.resolve(import.meta.dirname, "../fixtures/simple.docx");

type EntityFileField = {
  id: string;
  propertyId: string;
  content: { type: string };
};

type EntityWithFields = {
  fields?: EntityFileField[];
};

type CreateUploadedDocumentRouteOptions = {
  fileName: string;
  request: APIRequestContext;
  workspace: TestWorkspace;
};

type UploadedDocumentRoute = {
  entityId: string;
  path: string;
};

export const createUploadedDocumentRoute = async ({
  fileName,
  request,
  workspace,
}: CreateUploadedDocumentRouteOptions): Promise<UploadedDocumentRoute> => {
  const uploaded = await apiUploadDocx(
    request,
    workspace.id,
    workspace.filePropertyId,
    {
      name: fileName,
      mimeType: DOCX_MIME,
      buffer: await readFile(DOCX_PATH),
    },
  );

  const entity = await apiGet<EntityWithFields>(
    request,
    `/entities/${workspace.id}/entity/${uploaded.entityId}`,
  );
  const fileField = entity.fields?.find(
    (field) =>
      field.propertyId === workspace.filePropertyId &&
      field.content.type === "file",
  );
  if (!fileField) {
    throw new Error("Uploaded entity did not include the expected file field");
  }

  return {
    entityId: uploaded.entityId,
    path:
      `/workspaces/${workspace.id}/${workspace.viewId}/document` +
      `?entity=${uploaded.entityId}&field=${fileField.id}`,
  };
};
