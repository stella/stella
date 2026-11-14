import { Result, TaggedError } from "better-result";
import { TextDecoder } from "node:util";

import { declareFingerprintFields } from "@stll/errors";
import { decodeDeclared } from "@stll/mojibake/declared-charset";
import { sha256Hex } from "@stll/sha256/bun";

import { EU_CELLAR_LIMITS } from "./eu-cellar-limits";

const { documentBytes: MAX_BYTES } = EU_CELLAR_LIMITS;
const MEDIA_TYPES = {
  notice: ["application/xml", "text/xml"],
  xhtml: ["application/xhtml+xml"],
} as const satisfies Record<string, readonly string[]>;

class EuCellarBytesError extends TaggedError("EuCellarBytesError")<{
  message: string;
  reason: "empty" | "limits" | "mime" | "charset" | "encoding";
  cause?: unknown;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

type DecodeEuCellarBytesOptions = {
  bytes: Uint8Array;
  contentType: string | null;
  kind: keyof typeof MEDIA_TYPES;
};

/** Decode publisher bytes strictly; never hash a re-encoded text projection. */
export const decodeEuCellarBytes = ({
  bytes,
  contentType,
  kind,
}: DecodeEuCellarBytesOptions) => {
  if (bytes.byteLength === 0) {
    return Result.err(
      new EuCellarBytesError({
        message: "CELLAR response has no bytes",
        reason: "empty",
      }),
    );
  }
  if (bytes.byteLength > MAX_BYTES) {
    return Result.err(
      new EuCellarBytesError({
        message: "CELLAR response exceeds the byte limit",
        reason: "limits",
      }),
    );
  }
  const mediaType = contentType?.split(";").at(0)?.trim().toLowerCase();
  if (!MEDIA_TYPES[kind].some((allowed) => allowed === mediaType)) {
    return Result.err(
      new EuCellarBytesError({
        message: "CELLAR response has an unsupported media type",
        reason: "mime",
      }),
    );
  }
  const selected = Result.try({
    try: () => decodeDeclared(bytes, { contentType }),
    catch: (cause) =>
      new EuCellarBytesError({
        message: "CELLAR response charset detection failed",
        reason: "encoding",
        cause,
      }),
  });
  if (selected.isErr()) {
    return Result.err(selected.error);
  }
  const { charset, source } = selected.value;
  // The shared detector may fall back to a document declaration after an
  // unknown transport declaration; only a BOM can override that declaration.
  if (
    source !== "http" &&
    source !== "bom" &&
    contentType !== null &&
    /;\s*charset\s*=/iu.test(contentType)
  ) {
    return Result.err(
      new EuCellarBytesError({
        message: "CELLAR response declares an unsupported charset",
        reason: "charset",
      }),
    );
  }
  const decoded = Result.try({
    try: () => new TextDecoder(charset, { fatal: true }).decode(bytes),
    catch: (cause) =>
      new EuCellarBytesError({
        message: "CELLAR response bytes are malformed for their charset",
        reason: "encoding",
        cause,
      }),
  });
  if (decoded.isErr()) {
    return Result.err(decoded.error);
  }
  if (decoded.value.trim().length === 0) {
    return Result.err(
      new EuCellarBytesError({
        message: "CELLAR response contains no text",
        reason: "empty",
      }),
    );
  }
  return Result.ok({
    text: decoded.value,
    charset,
    source,
    sha256: sha256Hex(bytes),
  });
};
