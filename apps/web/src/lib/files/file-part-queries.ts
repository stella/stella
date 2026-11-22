import { queryOptions } from "@tanstack/react-query";
import { panic } from "better-result";
import * as v from "valibot";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { api } from "@/lib/api";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";
import { filesKeys, parseSuccessBody } from "@/lib/files/queries";
import { fetchStorageArrayBuffer } from "@/lib/files/storage-fetch";
import { toSafeId } from "@/lib/safe-id";
import { downloadFile } from "@/lib/utils";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

/** One part of a stored file: the file's field and the part's address. */
export type FilePartKey = {
  workspaceId: string;
  fieldId: string;
  /** The part, such as `attachment:0`, as the file's preview lists it. */
  part: string;
};

/**
 * The part link: a short-lived, audited grant for one part of a file, the
 * same path every part of every container opens through.
 */
const readFilePartLink = async (
  { workspaceId, fieldId, part }: FilePartKey,
  purpose: "display" | "download",
  signal?: AbortSignal,
) => {
  const response = await api
    .files({ workspaceId: toSafeId<"workspace">(workspaceId) })
    .url({ fieldId: toSafeId<"field">(fieldId) })
    .get({
      query: { purpose, part },
      ...(signal === undefined ? {} : { fetch: { signal } }),
    });
  const data = unwrapApiResponse(response);
  // With a `part` the endpoint answers with the part, never the file.
  return data.kind === "part"
    ? data
    : panic("The part link answered with the whole file");
};

export const filePartKeys = {
  content: ({ workspaceId, fieldId, part }: FilePartKey) => [
    ...filesKeys.all(),
    "part",
    workspaceId,
    fieldId,
    part,
  ],
};

/** A part's bytes for an in-place preview, cached like a file's own. */
export const filePartContentOptions = (key: FilePartKey) =>
  resourceQueryOptions(
    queryOptions({
      retry: false,
      queryKey: filePartKeys.content(key),
      queryFn: async ({ signal }) => {
        const link = await readFilePartLink(key, "display", signal);
        return await fetchStorageArrayBuffer(link.presignedUrl, {
          signal,
          purpose: "display",
        });
      },
    }),
    {
      resources: [
        RESOURCE_TYPE.ENTITY,
        RESOURCE_TYPE.FIELD,
        RESOURCE_TYPE.USER_FILE,
      ],
      scope: { type: "workspace", workspaceId: key.workspaceId },
    },
  );

// The same bound a file's own download has.
const FILE_PART_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Saves the part to this device under the name the server gives it. */
export const downloadFilePart = async (key: FilePartKey): Promise<void> => {
  const signal = AbortSignal.timeout(FILE_PART_DOWNLOAD_TIMEOUT_MS);
  const link = await readFilePartLink(key, "download", signal);
  const buffer = await fetchStorageArrayBuffer(link.presignedUrl, {
    signal,
    purpose: "download",
  });
  downloadFile(new Blob([buffer], { type: link.mimeType }), link.fileName);
};

const FILE_PART_SAVE_RESPONSE_SCHEMA = v.object({
  entityId: v.string(),
  fieldId: v.string(),
  fileName: v.string(),
  workspaceId: v.string(),
});

// Saving a part copies and re-derives it, like an upload.
const FILE_PART_SAVE_TIMEOUT_MS = 60_000;

type SaveFilePartInput = FilePartKey & {
  destinationWorkspaceId: string;
  parentId: string | null;
};

export const createFilePartWrites = (apiClient: typeof api) => ({
  /** Copies one part of a file into a matter as a document of its own. */
  saveFilePart: async ({
    workspaceId,
    fieldId,
    part,
    destinationWorkspaceId,
    parentId,
  }: SaveFilePartInput) =>
    await invokeAppOnlyWrite("files.part.save", async () =>
      parseSuccessBody(
        FILE_PART_SAVE_RESPONSE_SCHEMA,
        unwrapApiResponse(
          await apiClient
            .files({ workspaceId })
            .part({ fieldId })
            .save.post(
              { part, destinationWorkspaceId, parentId },
              { fetch: { timeoutMs: FILE_PART_SAVE_TIMEOUT_MS } },
            ),
        ),
        "Invalid file part save response",
      ),
    ),
});

export const { saveFilePart } = createFilePartWrites(api);
