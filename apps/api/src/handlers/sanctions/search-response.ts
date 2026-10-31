import * as v from "valibot";

import { safePublicHandlerResponseSchemasWithStatusText } from "@/api/lib/api-handlers";
import { SANCTIONS_MATCH_LIMIT } from "@/api/lib/lists/sanctions/screening-service";
import type { SanctionsScreening } from "@/api/lib/lists/sanctions/screening-service";
import {
  SANCTIONS_CLASSIFICATIONS,
  SANCTIONS_ENTITY_TYPES,
  SANCTIONS_FIELD_COMPARISONS,
  SANCTIONS_IDENTITY_FIELDS,
  SANCTIONS_PENDING_UPDATE_CODES,
  SANCTIONS_PUBLIC_UNAVAILABLE_REASONS,
  SANCTIONS_SCREENING_STATUSES,
  SANCTIONS_SOURCE_IDS,
} from "@/api/lib/lists/sanctions/screening-vocabulary";
import {
  boundedString,
  nullableBoundedString,
} from "@/api/lib/search/response-text-bounds";

const TEXT_BYTES = { metadata: 16_384, id: 1024, url: 8192, date: 64 } as const;
/** The public answer: the screening, and when to ask again while lists load. */
export type PublicSanctionsScreening = SanctionsScreening & {
  /** Seconds until a retry can find more lists loaded; null when none is loading. */
  retryAfterSeconds: number | null;
};

type ListOutcome = SanctionsScreening["lists"][number];
type PossibleMatch = ListOutcome["possibleMatches"][number];

const matchSchema = v.object({
  sourceEntryId: boundedString(TEXT_BYTES.id),
  editionId: boundedString(TEXT_BYTES.id),
  score: v.number(),
  sourceUrl: boundedString(TEXT_BYTES.url),
  name: nullableBoundedString(TEXT_BYTES.metadata),
  referenceNumber: nullableBoundedString(TEXT_BYTES.metadata),
  entityType: v.picklist(SANCTIONS_ENTITY_TYPES),
  programme: nullableBoundedString(TEXT_BYTES.metadata),
  listedOn: nullableBoundedString(TEXT_BYTES.date),
  evidence: v.object({
    nameScore: v.number(),
    matchedName: nullableBoundedString(TEXT_BYTES.metadata),
    birthDate: v.picklist(SANCTIONS_FIELD_COMPARISONS),
    nationality: v.picklist(SANCTIONS_FIELD_COMPARISONS),
    entityType: v.picklist(SANCTIONS_FIELD_COMPARISONS),
    identifier: v.picklist(SANCTIONS_FIELD_COMPARISONS),
    conflicts: v.pipe(
      v.array(v.picklist(SANCTIONS_IDENTITY_FIELDS)),
      v.maxLength(SANCTIONS_IDENTITY_FIELDS.length),
    ),
  } satisfies Record<keyof PossibleMatch["evidence"], v.GenericSchema>),
} satisfies Record<keyof PossibleMatch, v.GenericSchema>);

const successSchema = v.object({
  status: v.picklist(SANCTIONS_SCREENING_STATUSES),
  checkedAt: boundedString(TEXT_BYTES.date),
  cutoff: v.number(),
  lists: v.pipe(
    v.array(
      v.object({
        source: v.picklist(SANCTIONS_SOURCE_IDS),
        issuer: boundedString(2),
        classification: v.picklist(SANCTIONS_CLASSIFICATIONS),
        status: v.picklist(SANCTIONS_SCREENING_STATUSES),
        reason: v.union([
          v.picklist(SANCTIONS_PUBLIC_UNAVAILABLE_REASONS),
          v.null(),
        ]),
        editionId: nullableBoundedString(TEXT_BYTES.id),
        publishedAt: nullableBoundedString(TEXT_BYTES.date),
        verifiedAt: nullableBoundedString(TEXT_BYTES.date),
        pendingUpdate: v.union([
          v.object({
            code: v.picklist(SANCTIONS_PENDING_UPDATE_CODES),
            heldAt: boundedString(TEXT_BYTES.date),
            previousCount: v.union([v.number(), v.null()]),
            nextCount: v.union([v.number(), v.null()]),
          } satisfies Record<
            keyof NonNullable<ListOutcome["pendingUpdate"]>,
            v.GenericSchema
          >),
          v.null(),
        ]),
        totalMatches: v.number(),
        truncated: v.boolean(),
        possibleMatches: v.pipe(
          v.array(matchSchema),
          v.maxLength(SANCTIONS_MATCH_LIMIT),
        ),
      } satisfies Record<keyof ListOutcome, v.GenericSchema>),
    ),
    v.maxLength(SANCTIONS_SOURCE_IDS.length),
  ),
  retryAfterSeconds: v.union([v.number(), v.null()]),
} satisfies Record<keyof PublicSanctionsScreening, v.GenericSchema>);

true satisfies PublicSanctionsScreening extends v.InferOutput<
  typeof successSchema
>
  ? true
  : never;

export const publicSanctionsResponseSchema =
  safePublicHandlerResponseSchemasWithStatusText(successSchema);
