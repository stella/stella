import * as v from "valibot";

import { apiDateTimeSchema } from "@stll/api-contract/api-date";
import { Temporal } from "@stll/time";

import {
  type ImportDocumentSource,
  ORIGINAL_AUTHOR_NAME_MAX_LENGTH,
} from "@/api/lib/document-source";
import { externalRefSchema } from "@/api/lib/imports/external-ref";

/**
 * What the system a file is imported from knows about it and stella cannot
 * reconstruct. Every field but `source` is optional: a file-share export may
 * carry dates but no id, a document system an id and author but no dates.
 */
export const importOriginSchema = v.pipe(
  v.strictObject({
    source: externalRefSchema.entries.source,
    id: v.optional(externalRefSchema.entries.id),
    createdAt: v.optional(
      v.pipe(
        apiDateTimeSchema,
        v.description("When the file was created in the source system"),
      ),
    ),
    modifiedAt: v.optional(
      v.pipe(
        apiDateTimeSchema,
        v.description("When the file was last modified in the source system"),
      ),
    ),
    authorName: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(ORIGINAL_AUTHOR_NAME_MAX_LENGTH),
        v.description(
          "The author as the source system recorded them, for authors who are not stella users",
        ),
      ),
    ),
  }),
  v.description(
    "Set when the file is imported from another system, to keep its original dates, author and id as the version's provenance",
  ),
);

/** Instants are stored in one canonical UTC spelling whatever offset came in. */
const canonicalInstant = (value: string | undefined): string | null =>
  value === undefined ? null : Temporal.Instant.from(value).toString();

type ImportDocumentSourceOptions = {
  origin: v.InferOutput<typeof importOriginSchema>;
  contentHash: string;
};

export const importDocumentSource = ({
  contentHash,
  origin: { source, id, createdAt, modifiedAt, authorName },
}: ImportDocumentSourceOptions): ImportDocumentSource => ({
  kind: "import",
  contentHash,
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
