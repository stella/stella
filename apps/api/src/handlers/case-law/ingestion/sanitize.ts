import { isRecord } from "@/api/lib/type-guards";

export const DANGEROUS_CHARS = new RegExp(
  "[" +
    "\x00" +
    "\uFEFF\uFFFE" +
    "\u0000-\u0008" +
    "\u000B\u000C" +
    "\u000E-\u001F" +
    "\u200B-\u200D" +
    "\u2060" +
    "\uFFF9-\uFFFB" +
    "]",
  "g",
);

export const stripDangerousChars = (value: string): string =>
  value.replace(DANGEROUS_CHARS, "").replace(/\u00A0/g, " ");

const sanitizeMetadataValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return stripDangerousChars(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadataValue(item));
  }

  if (isRecord(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      sanitized[key] = sanitizeMetadataValue(nestedValue);
    }
    return sanitized;
  }

  return value;
};

export const sanitizeMetadata = (
  metadata: Record<string, unknown>,
): Record<string, unknown> => {
  const sanitized = sanitizeMetadataValue(metadata);
  return isRecord(sanitized) ? sanitized : {};
};
