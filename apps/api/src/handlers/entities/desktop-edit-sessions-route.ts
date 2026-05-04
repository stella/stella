import Elysia from "elysia";

import {
  checkpointDesktopEditSessionBodySchema,
  checkpointDesktopEditSessionHandler,
  checkpointDesktopEditSessionParamsSchema,
} from "@/api/handlers/entities/checkpoint-desktop-edit-session";
import {
  desktopEditSessionEventsHandler,
  desktopEditSessionEventsParamsSchema,
  desktopEditSessionEventsQuerySchema,
} from "@/api/handlers/entities/desktop-edit-session-events";
import {
  finalizeDesktopEditSessionBodySchema,
  finalizeDesktopEditSessionHandler,
  finalizeDesktopEditSessionParamsSchema,
} from "@/api/handlers/entities/finalize-desktop-edit-session";
import {
  respondDesktopEditTakeoverBodySchema,
  respondDesktopEditTakeoverHandler,
  respondDesktopEditTakeoverParamsSchema,
} from "@/api/handlers/entities/respond-desktop-edit-takeover";
import {
  statusDesktopEditSessionHandler,
  statusDesktopEditSessionParamsSchema,
  statusDesktopEditSessionQuerySchema,
} from "@/api/handlers/entities/status-desktop-edit-session";

export const desktopEditSessionsRoute = new Elysia({
  prefix: "/desktop-edit-sessions",
})
  .get(
    "/:sessionId/status",
    async ({ params, query }) =>
      await statusDesktopEditSessionHandler({
        query,
        sessionId: params.sessionId,
      }),
    {
      params: statusDesktopEditSessionParamsSchema,
      query: statusDesktopEditSessionQuerySchema,
    },
  )
  .get(
    "/:sessionId/events",
    async ({ params }) =>
      await desktopEditSessionEventsHandler({
        sessionId: params.sessionId,
      }),
    {
      params: desktopEditSessionEventsParamsSchema,
      query: desktopEditSessionEventsQuerySchema,
    },
  )
  .post(
    "/:sessionId/checkpoint",
    async ({ body, params }) =>
      await checkpointDesktopEditSessionHandler({
        body,
        sessionId: params.sessionId,
      }),
    {
      body: checkpointDesktopEditSessionBodySchema,
      params: checkpointDesktopEditSessionParamsSchema,
    },
  )
  .post(
    "/:sessionId/finalize",
    async ({ body, params }) =>
      await finalizeDesktopEditSessionHandler({
        body,
        sessionId: params.sessionId,
      }),
    {
      body: finalizeDesktopEditSessionBodySchema,
      params: finalizeDesktopEditSessionParamsSchema,
    },
  )
  .post(
    "/:sessionId/respond-takeover",
    async ({ body, params }) =>
      await respondDesktopEditTakeoverHandler({
        body,
        sessionId: params.sessionId,
      }),
    {
      body: respondDesktopEditTakeoverBodySchema,
      params: respondDesktopEditTakeoverParamsSchema,
    },
  );
