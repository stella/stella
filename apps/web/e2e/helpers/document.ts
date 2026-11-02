import type { APIRequestContext } from "@playwright/test";
import { panic } from "better-result";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { apiGet, apiUploadDocx } from "./api";
import type { TestWorkspace } from "./workspace";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_PATH = path.resolve(import.meta.dirname, "../fixtures/simple.docx");
const PDF_PATH = path.resolve(
  import.meta.dirname,
  "../../../api/src/lib/search/__fixtures__/mixed-3pages.pdf",
);
const DOCUMENT_FIXTURES = {
  docx: { mimeType: DOCX_MIME, path: DOCX_PATH },
  pdf: { mimeType: "application/pdf", path: PDF_PATH },
};

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
  fixture?: keyof typeof DOCUMENT_FIXTURES;
  request: APIRequestContext;
  workspace: TestWorkspace;
};

type UploadedDocumentRoute = {
  entityId: string;
  path: string;
};

export const createUploadedDocumentRoute = async ({
  fileName,
  fixture = "docx",
  request,
  workspace,
}: CreateUploadedDocumentRouteOptions): Promise<UploadedDocumentRoute> => {
  const file = DOCUMENT_FIXTURES[fixture];
  const uploaded = await apiUploadDocx(
    request,
    workspace.id,
    workspace.filePropertyId,
    {
      name: fileName,
      mimeType: file.mimeType,
      buffer: await readFile(file.path),
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
    panic("Uploaded entity did not include the expected file field");
  }

  return {
    entityId: uploaded.entityId,
    path:
      `/workspaces/${workspace.id}/${workspace.viewId}/document` +
      `?entity=${uploaded.entityId}&field=${fileField.id}`,
  };
};
