import { panic } from "better-result";

const ERROR_REFERENCE_BYTES = 6;
const ERROR_REFERENCE_PATTERN = /^ERR-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/u;

export type ErrorReference = `ERR-${string}-${string}-${string}`;

export const formatErrorReference = (bytes: Uint8Array): ErrorReference => {
  if (bytes.length !== ERROR_REFERENCE_BYTES) {
    return panic(`Expected ${ERROR_REFERENCE_BYTES} reference bytes`);
  }

  const hexadecimal = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0").toUpperCase(),
  ).join("");
  return `ERR-${hexadecimal.slice(0, 4)}-${hexadecimal.slice(4, 8)}-${hexadecimal.slice(8, 12)}`;
};

/**
 * Create an opaque support reference without accepting error, route, workspace,
 * or user data. The API shape makes sensitive-data inclusion impossible.
 */
export const createErrorReference = (): ErrorReference => {
  const bytes = new Uint8Array(ERROR_REFERENCE_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return formatErrorReference(bytes);
};

export const isErrorReference = (value: unknown): value is ErrorReference =>
  typeof value === "string" && ERROR_REFERENCE_PATTERN.test(value);
