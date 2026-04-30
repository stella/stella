import { Result } from "better-result";
import Elysia from "elysia";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { workspaceAccessMacro } from "@/api/lib/auth";

import { dateRangeQuerySchema, periodQuerySchema } from "./date-range-schema";
import { hoursByMatterHandler } from "./hours-by-matter";
import { hoursByPeriodHandler } from "./hours-by-period";
import { hoursByUserHandler } from "./hours-by-user";
import { revenueByPeriodHandler } from "./revenue-by-period";
import { statusBreakdownHandler } from "./status-breakdown";
import { summaryHandler } from "./summary";

const summaryEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    query: dateRangeQuerySchema,
  } satisfies HandlerConfig,
  async function* ({ query, scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await summaryHandler({ workspaceId, query, scopedDb }),
      ),
    );

    return Result.ok(response);
  },
);

const hoursByMatterEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    query: dateRangeQuerySchema,
  } satisfies HandlerConfig,
  async function* ({ query, scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await hoursByMatterHandler({ workspaceId, query, scopedDb }),
      ),
    );

    return Result.ok(response);
  },
);

const hoursByUserEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    query: dateRangeQuerySchema,
  } satisfies HandlerConfig,
  async function* ({ query, scopedDb, session, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await hoursByUserHandler({
            workspaceId,
            organizationId: session.activeOrganizationId,
            query,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const hoursByPeriodEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    query: periodQuerySchema,
  } satisfies HandlerConfig,
  async function* ({ query, scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await hoursByPeriodHandler({ workspaceId, query, scopedDb }),
      ),
    );

    return Result.ok(response);
  },
);

const statusBreakdownEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    query: dateRangeQuerySchema,
  } satisfies HandlerConfig,
  async function* ({ query, scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await statusBreakdownHandler({ workspaceId, query, scopedDb }),
      ),
    );

    return Result.ok(response);
  },
);

const revenueByPeriodEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    query: periodQuerySchema,
  } satisfies HandlerConfig,
  async function* ({ query, scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await revenueByPeriodHandler({ workspaceId, query, scopedDb }),
      ),
    );

    return Result.ok(response);
  },
);

export const analyticsRoute = new Elysia({
  prefix: "/analytics/:workspaceId",
})
  .use(workspaceAccessMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get("/summary", summaryEndpoint.handler, {
    query: summaryEndpoint.config.query,
  })
  .get("/hours-by-matter", hoursByMatterEndpoint.handler, {
    query: hoursByMatterEndpoint.config.query,
  })
  .get("/hours-by-user", hoursByUserEndpoint.handler, {
    query: hoursByUserEndpoint.config.query,
  })
  .get("/hours-by-period", hoursByPeriodEndpoint.handler, {
    query: hoursByPeriodEndpoint.config.query,
  })
  .get("/status-breakdown", statusBreakdownEndpoint.handler, {
    query: statusBreakdownEndpoint.config.query,
  })
  .get("/revenue-by-period", revenueByPeriodEndpoint.handler, {
    query: revenueByPeriodEndpoint.config.query,
  });
