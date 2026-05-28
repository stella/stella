import type { APIRequestContext } from "@playwright/test";

// The web client mounts the Eden treaty at `${VITE_API_URL}/v1`
// (apps/web/src/lib/api.ts:19); mirror that here so paths read the
// same way as the route definitions.
const API_BASE_URL = `${process.env["E2E_API_URL"] ?? "http://localhost:3001"}/v1`;

type Json =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null;

const url = (path: string) =>
  `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;

export const apiGet = async <T = unknown>(
  request: APIRequestContext,
  path: string,
): Promise<T> => {
  const response = await request.get(url(path));
  if (!response.ok()) {
    throw new Error(
      `GET ${path} -> ${String(response.status())}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
};

// Mutations behind the `invalidateQuery` macro require a non-empty
// `queryKey` array; the frontend's Eden client wires this automatically
// (apps/api/src/lib/invalidate-query-macro.ts:8). Tests don't care which
// cache key gets invalidated, so we send a stable sentinel.
const E2E_QUERY_KEY = ["e2e"];

export const apiPut = async <T = unknown>(
  request: APIRequestContext,
  path: string,
  body: Json,
  { invalidates = false }: { invalidates?: boolean } = {},
): Promise<T> => {
  const data =
    invalidates &&
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body)
      ? { ...body, queryKey: E2E_QUERY_KEY }
      : body;
  const response = await request.put(url(path), { data });
  if (!response.ok()) {
    throw new Error(
      `PUT ${path} -> ${String(response.status())}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
};

export const apiDelete = async (
  request: APIRequestContext,
  path: string,
  { invalidates = false }: { invalidates?: boolean } = {},
): Promise<void> => {
  const response = await request.delete(url(path), {
    ...(invalidates ? { data: { queryKey: E2E_QUERY_KEY } } : {}),
  });
  if (!response.ok() && response.status() !== 404) {
    throw new Error(
      `DELETE ${path} -> ${String(response.status())}: ${await response.text()}`,
    );
  }
};

export const apiUploadDocx = async (
  request: APIRequestContext,
  workspaceId: string,
  propertyId: string,
  file: { name: string; mimeType: string; buffer: Buffer },
) => {
  const response = await request.post(url(`/entities/${workspaceId}/upload`), {
    multipart: {
      file: {
        name: file.name,
        mimeType: file.mimeType,
        buffer: file.buffer,
      },
      name: file.name,
      propertyId,
      // /entities/:workspaceId/upload is wrapped by invalidateQuery.
      queryKey: JSON.stringify(E2E_QUERY_KEY),
    },
  });
  if (!response.ok()) {
    throw new Error(
      `POST /entities/${workspaceId}/upload -> ${String(response.status())}: ${await response.text()}`,
    );
  }
  return (await response.json()) as {
    entityId: string;
    fileId: string;
    fileName: string;
    renamed: boolean;
  };
};
