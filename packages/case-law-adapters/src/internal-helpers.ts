// parser-output-unchanged: internal pure helpers for @stll/case-law-adapters; runtime behavior unchanged.
import { isTaggedError, Result } from "better-result";

/** Narrow `unknown` to a plain object (not null, not array). */
export const isAdapterRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Structural tag for a tagged error or standard Error without DB/logger coupling. */
export const adapterErrorTag = (error: unknown): string => {
  const tagged = Result.try(() =>
    isTaggedError(error) ? error._tag : undefined,
  ).unwrapOr(undefined);
  if (tagged !== undefined) {
    return tagged;
  }
  if (error instanceof Error && error.name !== "" && error.name !== "Error") {
    return error.name;
  }
  return "UnknownError";
};

export function adapterArrayOrEmpty<T>(value: T[] | null | undefined): T[];
export function adapterArrayOrEmpty<T>(
  value: readonly T[] | null | undefined,
): readonly T[];
export function adapterArrayOrEmpty<T>(
  value: readonly T[] | null | undefined,
): readonly T[] {
  if (value === null || value === undefined) {
    return [];
  }
  return value;
}

/** A publisher role enum contains a value outside its declared vocabulary. */
export const ADAPTER_DOCUMENT_ROLE_UNMAPPED =
  "case_law.ingestion.document_role_unmapped";

type AdapterCorpusLicense =
  | "public-domain"
  | "official-open-data"
  | "cc-by"
  | "cc-by-sa"
  | "permitted-redistribution"
  | "restricted";

export type AdapterCorpusSourceDescriptor = {
  license: AdapterCorpusLicense;
  attribution: string | null;
  allowsRedistribution: boolean;
  allowsDerivedAi: boolean;
};
