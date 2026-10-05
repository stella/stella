import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { renderMatterReference } from "@stll/api-contract";

import { numberSeriesAllocations, numberSeriesCounters } from "@/api/db/schema";
import { numberSeriesParams } from "@/api/handlers/number-series/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { toNumberPatternScopeKey } from "@/api/lib/billing/number-pattern";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Preview the next number for a date without reserving it. A concurrent issue can change the result.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "billing_admin",
    consumesServices: false,
  },
  access: "read",
  params: numberSeriesParams,
  query: t.Object({
    issueDate: t.String({ format: "date", minLength: 10, maxLength: 10 }),
  }),
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ params, query, safeDb, session }) {
    const issuedAt = new Date(`${query.issueDate}T00:00:00.000Z`);
    const preview = yield* Result.await(
      safeDb(async (tx) => {
        const series = await tx.query.numberSeries.findFirst({
          columns: {
            id: true,
            documentType: true,
            pattern: true,
            padding: true,
          },
          where: {
            id: { eq: params.numberSeriesId },
            organizationId: { eq: session.activeOrganizationId },
            archivedAt: { isNull: true },
          },
        });
        if (!series) {
          return null;
        }
        const periodKey = toNumberPatternScopeKey({
          pattern: series.pattern,
          now: issuedAt,
          timeZone: "UTC",
        });
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
        const number = renderMatterReference({
          now: issuedAt,
          pattern: series.pattern,
          padding: series.padding,
          seq: (counter.at(0)?.lastValue ?? 0) + 1,
          timeZone: "UTC",
        });
        const existing = await tx
          .select({ number: numberSeriesAllocations.number })
          .from(numberSeriesAllocations)
          .where(
            and(
              eq(
                numberSeriesAllocations.organizationId,
                session.activeOrganizationId,
              ),
              eq(numberSeriesAllocations.documentType, series.documentType),
              eq(numberSeriesAllocations.number, number),
            ),
          )
          .limit(1);
        return {
          seriesId: series.id,
          number,
          availability:
            existing.length === 0 ? "available" : "already_allocated",
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
