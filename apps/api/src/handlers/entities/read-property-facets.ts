import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { entities, fields } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tConditionNode } from "@/api/lib/conditions/contract";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  buildFilterConditions,
  fieldValueExpr,
} from "@/api/lib/entity-filters";
import { LIMITS } from "@/api/lib/limits";

const FACET_VALUE_LIMIT = 50;

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "pending" },
  body: t.Object({
    propertyId: tSafeId("property"),
    filters: t.Optional(
      t.Array(tConditionNode, { maxItems: LIMITS.propertiesCount }),
    ),
  }),
} satisfies HandlerConfig;

type FacetValueRow = {
  value: string;
  count: number;
};

/**
 * Counts distinct present values for one property across the workspace,
 * respecting the supplied filter set. A multi-select stores its value as
 * a JSONB array, every other faceted property as a scalar string, so the
 * value expression unnests arrays element-by-element and falls back to
 * the scalar `fieldValueExpr` extraction otherwise. Each distinct value
 * counts the entities that carry it; for multi-select an entity counts
 * once per distinct value it holds.
 *
 * Counts respect the full current filter set, including any condition on
 * the faceted property itself. A future refinement could exclude the
 * facet's own property for true Notion-style "available options" counts;
 * that is intentionally not implemented here.
 */
const readPropertyFacets = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body }) {
    const filterConditions = buildFilterConditions(body.filters ?? []);
    const whereClause = and(
      eq(entities.workspaceId, workspaceId),
      ...filterConditions,
    );

    const facetValue = sql`CASE
      WHEN jsonb_typeof(${fields.content}->'value') = 'array'
        THEN array_value.value
      ELSE ${fieldValueExpr(fields.content)}
    END`;

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            value: sql<string>`${facetValue}`.as("facet_value"),
            count: sql<number>`count(distinct ${entities.id})::int`.as(
              "facet_count",
            ),
          })
          .from(fields)
          .innerJoin(
            entities,
            and(
              eq(fields.entityVersionId, entities.currentVersionId),
              eq(fields.propertyId, body.propertyId),
              whereClause,
            ),
          )
          // The LATERAL function is evaluated for every left row before the
          // join's ON predicate, so a scalar value would crash
          // jsonb_array_elements_text. Feed it an empty array for non-arrays;
          // the scalar branch of `facetValue` supplies those values instead.
          .leftJoin(
            sql`LATERAL jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(${fields.content}->'value') = 'array'
                  THEN ${fields.content}->'value'
                ELSE '[]'::jsonb
              END
            ) AS array_value(value)`,
            sql`true`,
          )
          .groupBy(sql`facet_value`)
          .having(sql`${facetValue} <> ''`)
          .orderBy(sql`facet_count DESC`, sql`facet_value ASC`)
          .limit(FACET_VALUE_LIMIT + 1),
      ),
    );

    const truncated = rows.length > FACET_VALUE_LIMIT;
    const values: FacetValueRow[] = rows
      .slice(0, FACET_VALUE_LIMIT)
      .map((row) => ({ value: row.value, count: row.count }));

    return Result.ok({ values, truncated });
  },
);

export default readPropertyFacets;
