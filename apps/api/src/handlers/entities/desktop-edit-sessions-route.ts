import Elysia from "elysia";

import {
  checkpointDesktopEditSessionBodySchema,
  checkpointDesktopEditSessionHandler,
  checkpointDesktopEditSessionParamsSchema,
} from "@/api/handlers/entities/checkpoint-desktop-edit-session";
import {
  acknowledgeDesktopEditHandoffOpenedBodySchema,
  acknowledgeDesktopEditHandoffOpenedHandler,
  acknowledgeDesktopEditHandoffOpenedParamsSchema,
  redeemDesktopEditHandoffBodySchema,
  redeemDesktopEditHandoffHandler,
} from "@/api/handlers/entities/desktop-edit-handoffs";
import {
  desktopEditSessionEventsHandler,
  desktopEditSessionEventsHeadersSchema,
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
  statusDesktopEditSessionHeadersSchema,
  statusDesktopEditSessionParamsSchema,
  statusDesktopEditSessionQuerySchema,
} from "@/api/handlers/entities/status-desktop-edit-session";

export const desktopEditSessionsRoute = new Elysia({
  prefix: "",
})
  .post(
    "/desktop-edit-handoffs/redeem",
    async ({ body }) => await redeemDesktopEditHandoffHandler({ body }),
    {
      body: redeemDesktopEditHandoffBodySchema,
    },
  )
  .post(
    "/desktop-edit-handoffs/:handoffId/opened",
    async ({ body, params }) =>
      await acknowledgeDesktopEditHandoffOpenedHandler({ body, params }),
    {
      body: acknowledgeDesktopEditHandoffOpenedBodySchema,
      params: acknowledgeDesktopEditHandoffOpenedParamsSchema,
    },
  )
  .get(
    "/desktop-edit-sessions/:sessionId/status",
    async ({ headers, params, query }) =>
      await statusDesktopEditSessionHandler({
        headers,
        query,
        sessionId: params.sessionId,
      }),
    {
      headers: statusDesktopEditSessionHeadersSchema,
      params: statusDesktopEditSessionParamsSchema,
      query: statusDesktopEditSessionQuerySchema,
    },
  )
  .get(
    "/desktop-edit-sessions/:sessionId/events",
    async ({ headers, params, query }) =>
      await desktopEditSessionEventsHandler({
        headers,
        query,
        sessionId: params.sessionId,
      }),
    {
      headers: desktopEditSessionEventsHeadersSchema,
      params: desktopEditSessionEventsParamsSchema,
      query: desktopEditSessionEventsQuerySchema,
    },
  )
  .post(
    "/desktop-edit-sessions/:sessionId/checkpoint",
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
    "/desktop-edit-sessions/:sessionId/finalize",
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
    "/desktop-edit-sessions/:sessionId/respond-takeover",
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
