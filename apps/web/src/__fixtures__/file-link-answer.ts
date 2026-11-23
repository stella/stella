import type { api } from "@/lib/api";

/** What the file link endpoint answers, as the typed client reads it. */
export type FileLinkAnswer = NonNullable<
  Awaited<
    ReturnType<ReturnType<ReturnType<typeof api.files>["url"]>["get"]>
  >["data"]
>;

/**
 * A complete answer of the file link endpoint for a whole file, for tests that
 * stand in for its transport. Typed against the client's own answer, so the
 * fixture carries every field the client reads (its decoder reads the type).
 */
export const fileLinkAnswer = ({
  fileName,
  mimeType,
  presignedUrl,
}: {
  fileName: string;
  mimeType: string;
  presignedUrl: string;
}): FileLinkAnswer => ({
  kind: "file",
  fileId: "file",
  fileName,
  mimeType,
  originalMimeType: mimeType,
  encrypted: false,
  presignedUrl,
  stampable: false,
});
