import { t } from "elysia";

import {
  CASE_LAW_RESEARCH_DISPOSITIONS,
  CASE_LAW_RESEARCH_QUERY_VERSION,
} from "@stll/api-contract";

import type { caseLawResearchTables } from "@/api/db/schema";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

/** Route-level mirror of `caseLawResearchSavedQuerySchema`; the handler re-parses. */
export const researchSavedQueryBodySchema = t.Object(
  {
    version: t.Literal(CASE_LAW_RESEARCH_QUERY_VERSION),
    query: t.String({ minLength: 1, maxLength: LIMITS.searchQueryMaxLength }),
    country: t.Optional(t.String({ maxLength: 3 })),
    court: t.Optional(t.String({ maxLength: 512 })),
    dateFrom: t.Optional(t.String({ format: "date" })),
    dateTo: t.Optional(t.String({ format: "date" })),
    decisionType: t.Optional(t.String({ maxLength: 128 })),
    language: t.Optional(t.String({ maxLength: 8 })),
    sourceId: t.Optional(tSafeId("caseLawSource")),
  },
  { additionalProperties: false },
);

export const researchTableNameSchema = t.String({
  minLength: 1,
  maxLength: 256,
});

export const researchTableParamsSchema = t.Object({
  tableId: tSafeId("caseLawResearchTable"),
});

export const researchTableDecisionParamsSchema = t.Object({
  tableId: tSafeId("caseLawResearchTable"),
  decisionId: tSafeId("caseLawDecision"),
});

export const researchTableListQuerySchema = t.Object({
  cursor: t.Optional(t.String({ maxLength: 512 })),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.caseLawResearchTablesPageSizeMax,
    }),
  ),
});

export const createResearchTableBodySchema = t.Object(
  {
    name: researchTableNameSchema,
    savedQuery: researchSavedQueryBodySchema,
  },
  { additionalProperties: false },
);

export const updateResearchTableBodySchema = t.Object(
  {
    name: t.Optional(researchTableNameSchema),
    savedQuery: t.Optional(researchSavedQueryBodySchema),
  },
  { additionalProperties: false },
);

export const setResearchTableDecisionBodySchema = t.Object(
  {
    decisionId: tSafeId("caseLawDecision"),
    disposition: t.UnionEnum(CASE_LAW_RESEARCH_DISPOSITIONS),
  },
  { additionalProperties: false },
);

export const toResearchTableResponse = (
  row: typeof caseLawResearchTables.$inferSelect,
) => ({
  id: row.id,
  name: row.name,
  ownerUserId: row.ownerUserId,
  savedQuery: row.savedQuery,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
