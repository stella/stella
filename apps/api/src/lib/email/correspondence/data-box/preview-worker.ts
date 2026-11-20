import { panic } from "better-result";
import type * as v from "valibot";

import { dataBoxPayloadIdentity } from "./payload-hash";
import type { dataBoxPreviewResultSchema } from "./preview-contract";
import { parseDataBoxDocument } from "./zfo";

/** Embedded bytes stay in the parser process. Only metadata crosses its output pipe. */
export const extractDataBoxPreview = (
  bytes: Uint8Array,
): v.InferOutput<typeof dataBoxPreviewResultSchema> => {
  const parsed = parseDataBoxDocument(bytes);
  if (parsed.isErr()) {
    return { kind: "unreadable" };
  }
  const document = parsed.value;
  switch (document.kind) {
    case "receipt":
      return document;
    case "message":
      return {
        kind: document.kind,
        annotation: document.annotation,
        envelope: document.envelope,
        ...dataBoxPayloadIdentity(document),
      };
    default:
      document satisfies never;
      return panic("Unhandled data-box document kind");
  }
};
