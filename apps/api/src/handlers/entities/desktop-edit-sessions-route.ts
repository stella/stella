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
  prefix: "",
})
  .post(
    "/desktop-edit-handoffs/redeem",
    async ({ body, request, server }) =>
      await redeemDesktopEditHandoffHandler({ body, request, server }),
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
    "/desktop-edit-sessions/:sessionId/events",
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
    "/desktop-edit-sessions/:sessionId/checkpoint",
    async ({ body, params, request, server }) =>
      await checkpointDesktopEditSessionHandler({
        body,
        sessionId: params.sessionId,
        request,
        server,
      }),
    {
      body: checkpointDesktopEditSessionBodySchema,
      params: checkpointDesktopEditSessionParamsSchema,
    },
  )
  .post(
    "/desktop-edit-sessions/:sessionId/finalize",
    async ({ body, params, request, server }) =>
      await finalizeDesktopEditSessionHandler({
        body,
        sessionId: params.sessionId,
        request,
        server,
      }),
    {
      body: finalizeDesktopEditSessionBodySchema,
      params: finalizeDesktopEditSessionParamsSchema,
    },
  )
  .post(
    "/desktop-edit-sessions/:sessionId/respond-takeover",
    async ({ body, params, request, server }) =>
      await respondDesktopEditTakeoverHandler({
        body,
        sessionId: params.sessionId,
        request,
        server,
      }),
    {
      body: respondDesktopEditTakeoverBodySchema,
      params: respondDesktopEditTakeoverParamsSchema,
    },
  );
