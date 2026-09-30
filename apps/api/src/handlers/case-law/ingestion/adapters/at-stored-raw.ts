import { Result } from "better-result";

import {
  encodeSourceRawEnvelope,
  LEGACY_RAW_SHAPES,
  readStoredRawListing,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  STORED_RAW_REPARSE_REJECTION,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  LegacyRawShapeAdapter,
  ReadStoredRawListingOptions,
  StoredRawListing,
} from "@/api/handlers/case-law/ingestion/adapter";
import { isRecord } from "@/api/lib/type-guards";

type ReadAtStoredRawListingOptions = ReadStoredRawListingOptions & {
  adapterKey: Extract<LegacyRawShapeAdapter, `at-${string}`>;
};

/** Read current envelopes and the listing/XML wrappers actually stored by AT adapters. */
export const readAtStoredRawListing = ({
  adapterKey,
  stored,
  ...listingOptions
}: ReadAtStoredRawListingOptions): StoredRawListing => {
  const shape = LEGACY_RAW_SHAPES[adapterKey][0];
  if (
    !shape.contentTypes.some(
      (contentType) => contentType === stored.contentType,
    )
  ) {
    return readStoredRawListing({ stored, ...listingOptions });
  }
  const wrapper = Result.try({
    try: (): unknown => JSON.parse(new TextDecoder().decode(stored.raw)),
    catch: () => null,
  }).unwrapOr(null);
  if (!isRecord(wrapper)) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.RAW_FIDELITY_LOST,
      detail: "the stored AT wrapper is not an object",
    };
  }
  const parts: Record<string, string> = {};
  for (const [key, part] of Object.entries(shape.keys)) {
    const value = wrapper[key];
    if (isRecord(value)) {
      parts[part] = JSON.stringify(value);
    } else if (typeof value === "string") {
      parts[part] = value;
    }
  }
  return readStoredRawListing({
    ...listingOptions,
    stored: {
      ...stored,
      raw: new TextEncoder().encode(encodeSourceRawEnvelope(parts)),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    },
  });
};
