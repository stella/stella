import * as v from "valibot";

import {
  EXTERNAL_ID_MAX_LENGTH,
  EXTERNAL_SOURCE_MAX_LENGTH,
  EXTERNAL_SOURCE_PATTERN,
} from "@/api/lib/imports/external-ref-limits";

/**
 * Where an imported row came from: the system it was exported from and its
 * identifier there. Re-running an import that carries the same ref updates
 * the row it created instead of adding a duplicate.
 */
export const externalRefSchema = v.pipe(
  v.strictObject({
    source: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(EXTERNAL_SOURCE_MAX_LENGTH),
      v.regex(EXTERNAL_SOURCE_PATTERN),
      v.description("Source key"),
    ),
    id: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(EXTERNAL_ID_MAX_LENGTH),
      v.description("Source ID"),
    ),
  }),
  v.description(
    "Source-system record identity; the importing operation updates or refuses an existing match",
  ),
);
export type ExternalRef = v.InferOutput<typeof externalRefSchema>;

/** Map key for one ref; the separator cannot occur in a source key. */
export const externalRefKey = ({ source, id }: ExternalRef): string =>
  `${source}\u0000${id}`;

/** The stored columns as the read contracts expose them. */
export const externalRefFromColumns = ({
  externalSource,
  externalId,
}: {
  externalSource: string | null;
  externalId: string | null;
}): ExternalRef | null =>
  externalSource === null || externalId === null
    ? null
    : { source: externalSource, id: externalId };
