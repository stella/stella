import { Result } from "better-result";
import Elysia from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { authMacro } from "@/api/lib/auth";

import {
  dateRangeQuerySchema,
  periodQuerySchema,
} from "../analytics/date-range-schema";
import { fillsByPeriodHandler } from "./fills-by-period";
import { fillsByUserHandler } from "./fills-by-user";
import { summaryHandler } from "./summary";
import { topTemplatesHandler } from "./top-templates";

const summaryEndpoint = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    query: dateRangeQuerySchema,
  } satisfies HandlerConfig,
  async function* ({ query, scopedDb, session }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await summaryHandler({
            organizationId: session.activeOrganizationId,
            query,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const fillsByPeriodEndpoint = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    query: periodQuerySchema,
  } satisfies HandlerConfig,
  async function* ({ query, scopedDb, session }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await fillsByPeriodHandler({
            organizationId: session.activeOrganizationId,
            query,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const topTemplatesEndpoint = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    query: dateRangeQuerySchema,
  } satisfies HandlerConfig,
  async function* ({ query, scopedDb, session }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await topTemplatesHandler({
            organizationId: session.activeOrganizationId,
            query,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const fillsByUserEndpoint = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    query: dateRangeQuerySchema,
  } satisfies HandlerConfig,
  async function* ({ query, scopedDb, session }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await fillsByUserHandler({
            organizationId: session.activeOrganizationId,
            query,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export const templateAnalyticsRoute = new Elysia({
  prefix: "/template-analytics",
})
  .use(authMacro)
  .guard({ validateAuth: true })
  .get("/summary", summaryEndpoint.handler, {
    query: summaryEndpoint.config.query,
  })
  .get("/fills-by-period", fillsByPeriodEndpoint.handler, {
    query: fillsByPeriodEndpoint.config.query,
  })
  .get("/top-templates", topTemplatesEndpoint.handler, {
    query: topTemplatesEndpoint.config.query,
  })
  .get("/fills-by-user", fillsByUserEndpoint.handler, {
    query: fillsByUserEndpoint.config.query,
  });
