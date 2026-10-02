import Elysia, { t } from "elysia";

import { SANCTIONS_SOURCES } from "@stll/sanctions";

import publicSanctionsSearch, {
  createPublicSanctionsSearchHandler,
} from "@/api/handlers/sanctions/search";
import type { PublicSanctionsSearchOptions } from "@/api/handlers/sanctions/search";
import {
  SANCTIONS_ENTITY_TYPES,
  SANCTIONS_FIELD_COMPARISONS,
  SANCTIONS_IDENTITY_FIELDS,
  SANCTIONS_PENDING_UPDATE_CODES,
  SANCTIONS_SCREENING_STATUSES,
  SANCTIONS_SOURCE_IDS,
  SANCTIONS_UNAVAILABLE_REASONS,
} from "@/api/lib/lists/sanctions/screening-vocabulary";
import { createPublicSanctionsRateLimitOptions } from "@/api/lib/rate-limit/public-sanctions";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import type { RateLimitOptions } from "@/api/lib/rate-limit/rate-limit";
import { applyResponseCachePolicy } from "@/api/lib/security-headers";

// Strict public objects exclude submitted identity at every nested level.
export const publicSanctionsResponseSchema = t.Object(
  {
    status: t.UnionEnum(SANCTIONS_SCREENING_STATUSES),
    checkedAt: t.String(),
    cutoff: t.Number(),
    lists: t.Array(
      t.Object(
        {
          source: t.UnionEnum(SANCTIONS_SOURCE_IDS),
          issuer: t.Union(
            SANCTIONS_SOURCE_IDS.map((source) =>
              t.Literal(SANCTIONS_SOURCES[source].issuer),
            ),
          ),
          classification: t.Literal("informational"),
          status: t.UnionEnum(SANCTIONS_SCREENING_STATUSES),
          reason: t.Nullable(t.UnionEnum(SANCTIONS_UNAVAILABLE_REASONS)),
          editionId: t.Nullable(t.String()),
          publishedAt: t.Nullable(t.String()),
          verifiedAt: t.Nullable(t.String()),
          totalMatches: t.Integer({ minimum: 0 }),
          truncated: t.Boolean(),
          pendingUpdate: t.Nullable(
            t.Object(
              {
                code: t.UnionEnum(SANCTIONS_PENDING_UPDATE_CODES),
                heldAt: t.String(),
                previousCount: t.Nullable(t.Integer()),
                nextCount: t.Nullable(t.Integer()),
              },
              { additionalProperties: false },
            ),
          ),
          possibleMatches: t.Array(
            t.Object(
              {
                sourceEntryId: t.String(),
                editionId: t.String(),
                score: t.Number(),
                sourceUrl: t.String(),
                name: t.Nullable(t.String()),
                referenceNumber: t.Nullable(t.String()),
                entityType: t.UnionEnum(SANCTIONS_ENTITY_TYPES),
                programme: t.Nullable(t.String()),
                listedOn: t.Nullable(t.String()),
                evidence: t.Object(
                  {
                    nameScore: t.Number(),
                    matchedName: t.Nullable(t.String()),
                    birthDate: t.UnionEnum(SANCTIONS_FIELD_COMPARISONS),
                    nationality: t.UnionEnum(SANCTIONS_FIELD_COMPARISONS),
                    entityType: t.UnionEnum(SANCTIONS_FIELD_COMPARISONS),
                    identifier: t.UnionEnum(SANCTIONS_FIELD_COMPARISONS),
                    conflicts: t.Array(t.UnionEnum(SANCTIONS_IDENTITY_FIELDS)),
                  },
                  { additionalProperties: false },
                ),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type PublicSanctionsRouteOptions = PublicSanctionsSearchOptions & {
  rateLimitOptions?: RateLimitOptions;
};

export const createPublicSanctionsRoute = (
  options?: PublicSanctionsRouteOptions,
) => {
  const search =
    options === undefined
      ? publicSanctionsSearch
      : createPublicSanctionsSearchHandler(options);
  return new Elysia({ prefix: "/sanctions" })
    .onRequest(({ set }) => {
      applyResponseCachePolicy({
        cache: search.config.cache,
        response: undefined,
        set,
      });
    })
    .use(
      rateLimit(
        options?.rateLimitOptions ?? createPublicSanctionsRateLimitOptions(),
      ),
    )
    .post("/search", search.handler, { body: search.config.body });
};

export const publicSanctionsRoute = createPublicSanctionsRoute();
