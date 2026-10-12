import { sha256Hex } from "@stll/sha256/node";

export type PropertyFailureRecord = {
  id: string;
  error: string;
};

const normalizeQuotedValues = (text: string): string => {
  const parts: string[] = [];
  const failedUntil = new Map<string, number>();
  let literalStart = 0;
  let start = 0;
  while (start < text.length) {
    const quote = text.charAt(start);
    if (
      (quote !== '"' && quote !== "'" && quote !== "`") ||
      start < (failedUntil.get(quote) ?? 0)
    ) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < text.length && text.charAt(end) !== quote) {
      if (text.charAt(end) !== "\\") {
        end++;
        continue;
      }
      const escaped = text.charAt(end + 1);
      if (
        escaped === "" ||
        escaped === "\r" ||
        escaped === "\n" ||
        escaped === "\u2028" ||
        escaped === "\u2029"
      ) {
        break;
      }
      end += 2;
    }
    if (end >= text.length || text.charAt(end) !== quote) {
      // Reusing failed suffixes bounds each character to one scan per delimiter.
      failedUntil.set(quote, end);
      start++;
      continue;
    }
    parts.push(text.slice(literalStart, start), "<value>");
    start = end + 1;
    literalStart = start;
  }
  parts.push(text.slice(literalStart));
  return parts.join("");
};

/** Group recurring assertions independently of generated values. */
export const failureFingerprint = ({
  id,
  error,
}: PropertyFailureRecord): string => {
  const firstLine = error.trim().split(/\r?\n/u).at(0) ?? "";
  const normalized = normalizeQuotedValues(firstLine)
    .replace(
      /\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/giu,
      "<value>",
    )
    .replace(/\b(?:0x[\da-f]+|[\da-f]{8,})\b/giu, "<value>")
    .replace(/[+-]?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/giu, "<value>")
    .replace(/\s+/gu, " ");
  return sha256Hex(`${id}\0${normalized}`).slice(0, 16);
};
