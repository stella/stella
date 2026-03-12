import Elysia from "elysia";

import { authMacro } from "@/api/lib/auth";

import {
  dateRangeQuerySchema,
  periodQuerySchema,
} from "../analytics/date-range-schema";
import { fillsByPeriodHandler } from "./fills-by-period";
import { fillsByUserHandler } from "./fills-by-user";
import { summaryHandler } from "./summary";
import { topTemplatesHandler } from "./top-templates";

export const templateAnalyticsRoute = new Elysia({
  prefix: "/template-analytics",
})
  .use(authMacro)
  .guard({ validateAuth: true })
  .get(
    "/summary",
    async (ctx) =>
      await summaryHandler({
        organizationId: ctx.session.activeOrganizationId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    { query: dateRangeQuerySchema },
  )
  .get(
    "/fills-by-period",
    async (ctx) =>
      await fillsByPeriodHandler({
        organizationId: ctx.session.activeOrganizationId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    { query: periodQuerySchema },
  )
  .get(
    "/top-templates",
    async (ctx) =>
      await topTemplatesHandler({
        organizationId: ctx.session.activeOrganizationId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    { query: dateRangeQuerySchema },
  )
  .get(
    "/fills-by-user",
    async (ctx) =>
      await fillsByUserHandler({
        organizationId: ctx.session.activeOrganizationId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    { query: dateRangeQuerySchema },
  );
