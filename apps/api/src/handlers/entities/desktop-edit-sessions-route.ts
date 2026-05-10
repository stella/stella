import Elysia from "elysia";

import {
  checkpointDesktopEditSessionBodySchema,
  checkpointDesktopEditSessionHandler,
  checkpointDesktopEditSessionParamsSchema,
} from "@/api/handlers/entities/checkpoint-desktop-edit-session";
import {
  desktopEditSessionEventsHandler,
  desktopEditSessionEventsHeadersSchema,
  desktopEditSessionEventsParamsSchema,
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
  statusDesktopEditSessionHeadersSchema,
  statusDesktopEditSessionParamsSchema,
} from "@/api/handlers/entities/status-desktop-edit-session";

export const desktopEditSessionsRoute = new Elysia({
  prefix: "/desktop-edit-sessions",
})
  .get(
    "/:sessionId/status",
    async ({ headers, params }) =>
      await statusDesktopEditSessionHandler({
        headers,
        sessionId: params.sessionId,
      }),
    {
      headers: statusDesktopEditSessionHeadersSchema,
      params: statusDesktopEditSessionParamsSchema,
    },
  )
  .get(
    "/:sessionId/events",
    async ({ headers, params }) =>
      await desktopEditSessionEventsHandler({
        headers,
        sessionId: params.sessionId,
      }),
    {
      headers: desktopEditSessionEventsHeadersSchema,
      params: desktopEditSessionEventsParamsSchema,
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
