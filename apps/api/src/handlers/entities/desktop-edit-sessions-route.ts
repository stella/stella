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
import { routes } from "@/api/http/route";
import type { DesktopHandoffAuthorizationDependencies } from "@/api/lib/business-registries/desktop/handoff-auth";
import { defineEndpoint } from "@/api/lib/endpoints";

const acknowledgeHandoffOpened = defineEndpoint.public(
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
);

const sessionStatus = defineEndpoint.public(
  {
    headers: statusDesktopEditSessionHeadersSchema,
    params: statusDesktopEditSessionParamsSchema,
  },
  async ({ headers, params }) =>
    await statusDesktopEditSessionHandler({
      headers,
      sessionId: params.sessionId,
    }),
);

const sessionEvents = defineEndpoint.public(
  {
    headers: desktopEditSessionEventsHeadersSchema,
    params: desktopEditSessionEventsParamsSchema,
  },
  async ({ headers, params }) =>
    await desktopEditSessionEventsHandler({
      headers,
      sessionId: params.sessionId,
    }),
);

const checkpointSession = defineEndpoint.public(
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
);

const finalizeSession = defineEndpoint.public(
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
);

const respondTakeover = defineEndpoint.public(
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

/**
 * Desktop-facing edit sessions. Each call carries a desktop account, handoff
 * or session credential that its handler checks itself, so the routes admit
 * any caller.
 */
export const createDesktopEditSessionsRoute = (
  dependencies?: DesktopHandoffAuthorizationDependencies,
) =>
  routes({
    "/desktop-edit-handoffs/redeem": {
      POST: defineEndpoint.public(
        { body: redeemDesktopEditHandoffBodySchema },
        async ({ body, request, server }) =>
          await redeemDesktopEditHandoffHandler(
            { body, request, server },
            dependencies,
          ),
      ),
    },
    "/desktop-edit-handoffs/:handoffId/opened": {
      POST: acknowledgeHandoffOpened,
    },
    "/desktop-edit-sessions/:sessionId/status": { GET: sessionStatus },
    "/desktop-edit-sessions/:sessionId/events": { GET: sessionEvents },
    "/desktop-edit-sessions/:sessionId/checkpoint": {
      POST: checkpointSession,
    },
    "/desktop-edit-sessions/:sessionId/finalize": { POST: finalizeSession },
    "/desktop-edit-sessions/:sessionId/respond-takeover": {
      POST: respondTakeover,
    },
  });

export const desktopEditSessionsRoute = createDesktopEditSessionsRoute();
