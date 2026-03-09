import Elysia from "elysia";

import { workspaceAccessMacro } from "@/api/lib/auth";
import { dateRangeQuerySchema, periodQuerySchema } from "./date-range-schema";
import { hoursByMatterHandler } from "./hours-by-matter";
import { hoursByPeriodHandler } from "./hours-by-period";
import { hoursByUserHandler } from "./hours-by-user";
import { revenueByPeriodHandler } from "./revenue-by-period";
import { statusBreakdownHandler } from "./status-breakdown";
import { summaryHandler } from "./summary";

export const analyticsRoute = new Elysia({
  prefix: "/analytics/:workspaceId",
})
  .use(workspaceAccessMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get(
    "/summary",
    (ctx) =>
      summaryHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    { query: dateRangeQuerySchema },
  )
  .get(
    "/hours-by-matter",
    (ctx) =>
      hoursByMatterHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    { query: dateRangeQuerySchema },
  )
  .get(
    "/hours-by-user",
    (ctx) =>
      hoursByUserHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    { query: dateRangeQuerySchema },
  )
  .get(
    "/hours-by-period",
    (ctx) =>
      hoursByPeriodHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    { query: periodQuerySchema },
  )
  .get(
    "/status-breakdown",
    (ctx) =>
      statusBreakdownHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    { query: dateRangeQuerySchema },
  )
  .get(
    "/revenue-by-period",
    (ctx) =>
      revenueByPeriodHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    { query: periodQuerySchema },
  );
