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
import type { DesktopHandoffAuthorizationDependencies } from "@/api/lib/business-registries/desktop/handoff-auth";

export const createDesktopEditSessionsRoute = (
  dependencies?: DesktopHandoffAuthorizationDependencies,
) =>
  new Elysia({
    prefix: "",
  })
    .post(
      "/desktop-edit-handoffs/redeem",
      {
        body: redeemDesktopEditHandoffBodySchema,
      },
      async ({ body, request, server }) =>
        await redeemDesktopEditHandoffHandler(
          { body, request, server },
          dependencies,
        ),
    )
    .post(
      "/desktop-edit-handoffs/:handoffId/opened",
      {
        body: acknowledgeDesktopEditHandoffOpenedBodySchema,
        params: acknowledgeDesktopEditHandoffOpenedParamsSchema,
      },
      async ({ body, params, request }) =>
        await acknowledgeDesktopEditHandoffOpenedHandler({
          body,
          params,
          request,
        }),
    )
    .get(
      "/desktop-edit-sessions/:sessionId/status",
      {
        headers: statusDesktopEditSessionHeadersSchema,
        params: statusDesktopEditSessionParamsSchema,
      },
      async ({ headers, params }) =>
        await statusDesktopEditSessionHandler({
          headers,
          sessionId: params.sessionId,
        }),
    )
    .get(
      "/desktop-edit-sessions/:sessionId/events",
      {
        headers: desktopEditSessionEventsHeadersSchema,
        params: desktopEditSessionEventsParamsSchema,
      },
      async ({ headers, params }) =>
        await desktopEditSessionEventsHandler({
          headers,
          sessionId: params.sessionId,
        }),
    )
    .post(
      "/desktop-edit-sessions/:sessionId/checkpoint",
      {
        body: checkpointDesktopEditSessionBodySchema,
        params: checkpointDesktopEditSessionParamsSchema,
      },
      async ({ body, params, request, server }) =>
        await checkpointDesktopEditSessionHandler({
          body,
          sessionId: params.sessionId,
          request,
          server,
        }),
    )
    .post(
      "/desktop-edit-sessions/:sessionId/finalize",
      {
        body: finalizeDesktopEditSessionBodySchema,
        params: finalizeDesktopEditSessionParamsSchema,
      },
      async ({ body, params, request, server }) =>
        await finalizeDesktopEditSessionHandler({
          body,
          sessionId: params.sessionId,
          request,
          server,
        }),
    )
    .post(
      "/desktop-edit-sessions/:sessionId/respond-takeover",
      {
        body: respondDesktopEditTakeoverBodySchema,
        params: respondDesktopEditTakeoverParamsSchema,
      },
      async ({ body, params, request, server }) =>
        await respondDesktopEditTakeoverHandler({
          body,
          sessionId: params.sessionId,
          request,
          server,
        }),
    );

export const desktopEditSessionsRoute = createDesktopEditSessionsRoute();
