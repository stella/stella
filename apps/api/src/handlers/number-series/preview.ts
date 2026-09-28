import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { renderMatterReference } from "@stll/api-contract";

import { numberSeriesCounters } from "@/api/db/schema";
import { numberSeriesParams } from "@/api/handlers/number-series/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { toNumberPatternScopeKey } from "@/api/lib/number-pattern";

const config = {
  description:
    "Preview the next number for a date without reserving it. A concurrent issue can change the result.",
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "capability", reason: "billing_admin" },
  access: "read",
  params: numberSeriesParams,
  query: t.Object({
    issuedAt: t.String({ format: "date-time", maxLength: 40 }),
  }),
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ params, query, safeDb, session }) {
    const issuedAt = new Date(query.issuedAt);
    const preview = yield* Result.await(
      safeDb(async (tx) => {
        const series = await tx.query.numberSeries.findFirst({
          columns: { id: true, pattern: true, padding: true },
          where: {
            id: { eq: params.numberSeriesId },
            organizationId: { eq: session.activeOrganizationId },
            archivedAt: { isNull: true },
          },
        });
        if (!series) {
          return null;
        }
        const periodKey = toNumberPatternScopeKey(series.pattern, issuedAt);
        const counter = await tx
          .select({ lastValue: numberSeriesCounters.lastValue })
          .from(numberSeriesCounters)
          .where(
            and(
              eq(numberSeriesCounters.seriesId, series.id),
              eq(
                numberSeriesCounters.organizationId,
                session.activeOrganizationId,
              ),
              eq(numberSeriesCounters.periodKey, periodKey),
            ),
          )
          .limit(1);
        return {
          seriesId: series.id,
          number: renderMatterReference({
            now: issuedAt,
            pattern: series.pattern,
            padding: series.padding,
            seq: (counter.at(0)?.lastValue ?? 0) + 1,
          }),
        };
      }),
    );
    if (!preview) {
      return Result.err(
        new HandlerError({ status: 404, message: "Number series not found" }),
      );
    }
    return Result.ok(preview);
  },
);
