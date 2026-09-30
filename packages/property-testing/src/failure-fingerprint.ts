import { createHash } from "node:crypto";

export type PropertyFailureRecord = {
  id: string;
  error: string;
};

/** Group recurring assertions independently of generated values. */
export const failureFingerprint = ({
  id,
  error,
}: PropertyFailureRecord): string => {
  const firstLine = error.trim().split(/\r?\n/u).at(0) ?? "";
  const normalized = firstLine
    .replace(
      /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gu,
      "<value>",
    )
    .replace(
      /\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/giu,
      "<value>",
    )
    .replace(/\b(?:0x[\da-f]+|[\da-f]{8,})\b/giu, "<value>")
    .replace(/[+-]?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/giu, "<value>")
    .replace(/\s+/gu, " ");
  return createHash("sha256")
    .update(`${id}\0${normalized}`)
    .digest("hex")
    .slice(0, 16);
};
