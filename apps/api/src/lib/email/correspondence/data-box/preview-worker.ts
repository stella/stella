import { panic } from "better-result";
import type * as v from "valibot";

import { partMediaType } from "@/api/lib/files/part-media-type";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

import { dataBoxPayloadIdentity } from "./payload-hash";
import type { dataBoxPreviewResultSchema } from "./preview-contract";
import { parseDataBoxDocument } from "./zfo";

/** Embedded bytes stay in the parser process. Only metadata crosses its output pipe. */
export const extractDataBoxPreview = async (
  bytes: Uint8Array,
): Promise<v.InferOutput<typeof dataBoxPreviewResultSchema>> => {
  const parsed = parseDataBoxDocument(bytes);
  if (parsed.isErr()) {
    return { kind: "unreadable" };
  }
  const document = parsed.value;
  switch (document.kind) {
    case "receipt":
      return document;
    case "message": {
      const identity = dataBoxPayloadIdentity(document);
      // Typed as the part reader types each file, from its bytes first.
      const files = await Promise.all(
        identity.files.map(async (file, index) => {
          const fileBytes = document.files[index]?.bytes ?? new Uint8Array();
          // Listed by the name the part link delivers it under; the payload
          // identity keeps the stated one.
          const fileName = sanitizeFilenamePreservingExtension(file.fileName);
          return {
            ...file,
            fileName,
            mediaType: await partMediaType({
              bytes: fileBytes,
              stated: file.mimeType,
              fileName,
            }),
            sizeBytes: fileBytes.byteLength,
          };
        }),
      );
      return {
        kind: document.kind,
        annotation: document.annotation,
        envelope: document.envelope,
        contentHash: identity.contentHash,
        files,
      };
    }
    default:
      document satisfies never;
      return panic("Unhandled data-box document kind");
  }
};
