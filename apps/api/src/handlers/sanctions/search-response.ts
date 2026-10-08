import type { TSchema } from "@sinclair/typebox";
import { t } from "elysia";
import type { Static } from "elysia";

import { safePublicHandlerResponseSchemasWithStatusText } from "@/api/lib/api-handlers";
import { SANCTIONS_MATCH_LIMIT } from "@/api/lib/lists/sanctions/screening-service";
import type { SanctionsScreening } from "@/api/lib/lists/sanctions/screening-service";
import {
  SANCTIONS_CLASSIFICATIONS,
  SANCTIONS_ENTITY_TYPES,
  SANCTIONS_FIELD_COMPARISONS,
  SANCTIONS_IDENTITY_FIELDS,
  SANCTIONS_PENDING_UPDATE_CODES,
  SANCTIONS_SCREENING_STATUSES,
  SANCTIONS_SOURCE_IDS,
  SANCTIONS_UNAVAILABLE_REASONS,
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

const matchSchema = t.Object(
  {
    sourceEntryId: boundedString(TEXT_BYTES.id),
    editionId: boundedString(TEXT_BYTES.id),
    score: t.Number(),
    sourceUrl: boundedString(TEXT_BYTES.url),
    name: nullableBoundedString(TEXT_BYTES.metadata),
    referenceNumber: nullableBoundedString(TEXT_BYTES.metadata),
    entityType: t.UnionEnum(SANCTIONS_ENTITY_TYPES),
    programme: nullableBoundedString(TEXT_BYTES.metadata),
    listedOn: nullableBoundedString(TEXT_BYTES.date),
    evidence: t.Object(
      {
        nameScore: t.Number(),
        matchedName: nullableBoundedString(TEXT_BYTES.metadata),
        birthDate: t.UnionEnum(SANCTIONS_FIELD_COMPARISONS),
        nationality: t.UnionEnum(SANCTIONS_FIELD_COMPARISONS),
        entityType: t.UnionEnum(SANCTIONS_FIELD_COMPARISONS),
        identifier: t.UnionEnum(SANCTIONS_FIELD_COMPARISONS),
        conflicts: t.Array(t.UnionEnum(SANCTIONS_IDENTITY_FIELDS), {
          maxItems: SANCTIONS_IDENTITY_FIELDS.length,
        }),
      } satisfies Record<keyof PossibleMatch["evidence"], TSchema>,
      { additionalProperties: false },
    ),
  } satisfies Record<keyof PossibleMatch, TSchema>,
  { additionalProperties: false },
);

const successSchema = t.Object(
  {
    status: t.UnionEnum(SANCTIONS_SCREENING_STATUSES),
    checkedAt: boundedString(TEXT_BYTES.date),
    cutoff: t.Number(),
    lists: t.Array(
      t.Object(
        {
          source: t.UnionEnum(SANCTIONS_SOURCE_IDS),
          issuer: boundedString(2),
          classification: t.UnionEnum(SANCTIONS_CLASSIFICATIONS),
          status: t.UnionEnum(SANCTIONS_SCREENING_STATUSES),
          reason: t.Union([
            t.UnionEnum(SANCTIONS_UNAVAILABLE_REASONS),
            t.Null(),
          ]),
          editionId: nullableBoundedString(TEXT_BYTES.id),
          publishedAt: nullableBoundedString(TEXT_BYTES.date),
          verifiedAt: nullableBoundedString(TEXT_BYTES.date),
          pendingUpdate: t.Union([
            t.Object(
              {
                code: t.UnionEnum(SANCTIONS_PENDING_UPDATE_CODES),
                heldAt: boundedString(TEXT_BYTES.date),
                previousCount: t.Union([t.Number(), t.Null()]),
                nextCount: t.Union([t.Number(), t.Null()]),
              } satisfies Record<
                keyof NonNullable<ListOutcome["pendingUpdate"]>,
                TSchema
              >,
              { additionalProperties: false },
            ),
            t.Null(),
          ]),
          totalMatches: t.Number(),
          truncated: t.Boolean(),
          possibleMatches: t.Array(matchSchema, {
            maxItems: SANCTIONS_MATCH_LIMIT,
          }),
        } satisfies Record<keyof ListOutcome, TSchema>,
        { additionalProperties: false },
      ),
      { maxItems: SANCTIONS_SOURCE_IDS.length },
    ),
    retryAfterSeconds: t.Union([t.Number(), t.Null()]),
  } satisfies Record<keyof PublicSanctionsScreening, TSchema>,
  { additionalProperties: false },
);

true satisfies PublicSanctionsScreening extends Static<typeof successSchema>
  ? true
  : never;

export const publicSanctionsResponseSchema =
  safePublicHandlerResponseSchemasWithStatusText(successSchema);
