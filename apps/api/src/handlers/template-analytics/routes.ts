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
    (ctx) =>
      summaryHandler({
        organizationId: ctx.session.activeOrganizationId,
        query: ctx.query,
      }),
    { query: dateRangeQuerySchema },
  )
  .get(
    "/fills-by-period",
    (ctx) =>
      fillsByPeriodHandler({
        organizationId: ctx.session.activeOrganizationId,
        query: ctx.query,
      }),
    { query: periodQuerySchema },
  )
  .get(
    "/top-templates",
    (ctx) =>
      topTemplatesHandler({
        organizationId: ctx.session.activeOrganizationId,
        query: ctx.query,
      }),
    { query: dateRangeQuerySchema },
  )
  .get(
    "/fills-by-user",
    (ctx) =>
      fillsByUserHandler({
        organizationId: ctx.session.activeOrganizationId,
        query: ctx.query,
      }),
    { query: dateRangeQuerySchema },
  );
