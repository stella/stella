import * as v from "valibot";

import type {
  SourceFieldDisposition,
  SourceFieldInventory,
} from "@stll/case-law-ingestion-core/ingestion-types";
import type { SourceRawParts } from "@stll/case-law-ingestion-core/source-raw-envelope";
import { load } from "@stll/html";

/**
 * Soft-law publishers expose listings only: no count endpoint and no
 * exhaustive date-slice interface. `reason` states why for this publisher.
 */
export const listingOnlyCoverage = (reason: string) => ({
  getTotalCount: async () =>
    await Promise.resolve({ type: "no-count-endpoint" as const }),
  sliceWalk: { type: "unsupported" as const, reason },
});

type SelectorSourceFieldsOptions<Field extends string> = {
  fields: Readonly<Record<Field, SourceFieldDisposition>>;
  selectors: Readonly<Record<Field, string>>;
  /** The stored HTML part the selectors read. */
  part: string;
};

/** Declares a source's fields as those whose selector matches a stored page. */
export const selectorSourceFields = <Field extends string>({
  fields,
  selectors,
  part,
}: SelectorSourceFieldsOptions<Field>) =>
  ({
    status: "declared",
    fields,
    listSourceFields: (parts: SourceRawParts) => {
      const $ = load(parts[part] ?? "");
      return Object.entries(selectors).flatMap(([field, selector]) =>
        typeof selector === "string" && $(selector).length > 0 ? [field] : [],
      );
    },
  }) satisfies SourceFieldInventory;

/** `<offset>:<listing digest>`; the digest ties the offset to the listing order it counts. */
const listingOffsetCursorSchema = v.nullable(
  v.strictTuple([
    v.pipe(
      v.string(),
      v.regex(/^(?:0|[1-9]\d*)$/u),
      v.toNumber(),
      v.safeInteger(),
    ),
    v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
  ]),
);

/** Reads a walk's cursor over one unpaginated listing; `null` starts the walk. */
export const parseListingOffsetCursor = (cursor: string | null) =>
  v.safeParse(listingOffsetCursorSchema, cursor?.split(":") ?? null);

type ListingOffsetPosition = v.InferOutput<typeof listingOffsetCursorSchema>;

/**
 * The offset a walk resumes at. A changed listing shifts the rows an offset
 * counts, so the walk restarts and no row moves past the checkpoint unseen.
 */
export const resumeListingOffset = (
  position: ListingOffsetPosition,
  digest: string,
) => {
  const [offset, checkpointDigest] = position ?? [0, digest];
  return checkpointDigest === digest ? offset : 0;
};
