import { t } from "elysia";
import type { Static } from "elysia";

import { Temporal } from "@stll/time";

import {
  type ImportDocumentSource,
  ORIGINAL_AUTHOR_NAME_MAX_LENGTH,
} from "@/api/lib/document-source";
import { tExternalRef } from "@/api/lib/imports/external-ref";

/**
 * What the system a file is imported from knows about it and stella cannot
 * reconstruct. Every field but `source` is optional: a file-share export may
 * carry dates but no id, a document system an id and author but no dates.
 */
export const tImportOrigin = t.Object(
  {
    source: tExternalRef.properties.source,
    id: t.Optional(tExternalRef.properties.id),
    createdAt: t.Optional(
      t.String({
        format: "date-time",
        description: "When the file was created in the source system",
      }),
    ),
    modifiedAt: t.Optional(
      t.String({
        format: "date-time",
        description: "When the file was last modified in the source system",
      }),
    ),
    authorName: t.Optional(
      t.String({
        minLength: 1,
        maxLength: ORIGINAL_AUTHOR_NAME_MAX_LENGTH,
        description:
          "The author as the source system recorded them, for authors who " +
          "are not stella users",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "Set when the file is imported from another system, to keep its " +
      "original dates, author and id as the version's provenance",
  },
);

/** Instants are stored in one canonical UTC spelling whatever offset came in. */
const canonicalInstant = (value: string | undefined): string | null =>
  value === undefined ? null : Temporal.Instant.from(value).toString();

export const importDocumentSource = ({
  source,
  id,
  createdAt,
  modifiedAt,
  authorName,
}: Static<typeof tImportOrigin>): ImportDocumentSource => ({
  kind: "import",
  externalSource: source,
  externalId: id ?? null,
  originalCreatedAt: canonicalInstant(createdAt),
  originalModifiedAt: canonicalInstant(modifiedAt),
  originalAuthorName: authorName ?? null,
});

/** The stored provenance as read contracts expose it, in the input's terms. */
export const importOriginOf = ({
  externalSource,
  externalId,
  originalCreatedAt,
  originalModifiedAt,
  originalAuthorName,
}: ImportDocumentSource) => ({
  source: externalSource,
  id: externalId,
  createdAt: originalCreatedAt,
  modifiedAt: originalModifiedAt,
  authorName: originalAuthorName,
});
