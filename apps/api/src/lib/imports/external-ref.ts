import { t } from "elysia";

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
export type ExternalRef = { source: string; id: string };

export const tExternalRef = t.Object(
  {
    source: t.String({
      minLength: 1,
      maxLength: EXTERNAL_SOURCE_MAX_LENGTH,
      pattern: EXTERNAL_SOURCE_PATTERN.source,
      description: "Lowercase source-system key (product or file-format name)",
    }),
    id: t.String({
      minLength: 1,
      maxLength: EXTERNAL_ID_MAX_LENGTH,
      description: "Source-system record ID",
    }),
  },
  {
    additionalProperties: false,
    description:
      "Source-system record identity; the importing operation updates or " +
      "refuses an existing match",
  },
);

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
