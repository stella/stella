import { Result, TaggedError } from "better-result";

import { UPLOAD_DOCUMENT_MAX_BYTES } from "@stll/api-contract/limits";
import { declareFingerprintFields } from "@stll/errors";

import {
  CMS_DATA_OID,
  hasCmsSignedDataHeader,
  readCmsSignedData,
} from "./cms-signed-data";

export const P7M_LIMITS = {
  maxFileBytes: UPLOAD_DOCUMENT_MAX_BYTES,
  maxLayers: 8,
} as const;

const P7M_PARSE_MESSAGES = {
  too_large: "The file exceeds the size limit",
  not_signed_data: "The file does not contain CMS SignedData",
  unsupported_content: "The signed content type is unsupported",
  detached: "The signed content is detached",
  too_many_layers: "The file exceeds the signed envelope nesting limit",
} as const;

export class P7mParseError extends TaggedError("P7mParseError")<{
  message: string;
  reason: keyof typeof P7M_PARSE_MESSAGES;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const failure = (reason: keyof typeof P7M_PARSE_MESSAGES) =>
  Result.err(
    new P7mParseError({ reason, message: P7M_PARSE_MESSAGES[reason] }),
  );

/** Reads encapsulated documents and signer metadata from outermost to innermost. */
export const parseP7m = (bytes: Uint8Array) => {
  if (bytes.byteLength > P7M_LIMITS.maxFileBytes) {
    return failure("too_large");
  }
  const layers = [];
  let documentBytes = bytes;
  for (let depth = 0; depth < P7M_LIMITS.maxLayers; depth++) {
    const layer = readCmsSignedData(documentBytes);
    if (layer.isErr()) {
      return failure(layer.error);
    }
    const { contentType, content, signers } = layer.value;
    if (signers.length === 0) {
      return failure("not_signed_data");
    }
    if (contentType !== CMS_DATA_OID) {
      return failure("unsupported_content");
    }
    layers.push({ signers });
    documentBytes = content;
    if (!hasCmsSignedDataHeader(documentBytes)) {
      return Result.ok({ bytes: documentBytes, layers });
    }
  }
  return failure("too_many_layers");
};
