import { panic } from "better-result";

declare const scanMediaTypeBrand: unique symbol;

/**
 * A media type reduced to its lowercase `type/subtype` essence: parameters
 * dropped, whitespace trimmed. Every media-type set and table the upload
 * scan compares against is keyed by this type, so a declared type has to go
 * through `scanMediaType` before any comparison compiles.
 */
export type ScanMediaType = string & { readonly [scanMediaTypeBrand]: true };

const essence = (mediaType: string): string =>
  (mediaType.split(";", 1).at(0) ?? "").trim().toLowerCase();

const isScanMediaType = (value: string): value is ScanMediaType =>
  value === essence(value);

/** The comparable form of a declared or listed media type. */
export const scanMediaType = (mediaType: string): ScanMediaType => {
  const normalized = essence(mediaType);
  return isScanMediaType(normalized)
    ? normalized
    : panic(`Media type essence is not stable: ${normalized}`);
};

/** A lookup set of media types, normalized like every value checked in it. */
export const scanMediaTypeSet = (
  mediaTypes: Iterable<string>,
): ReadonlySet<ScanMediaType> =>
  new Set(Array.from(mediaTypes, (mediaType) => scanMediaType(mediaType)));
