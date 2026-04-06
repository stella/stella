import Elysia from "elysia";

import {
  checkpointDesktopEditSessionBodySchema,
  checkpointDesktopEditSessionHandler,
  checkpointDesktopEditSessionParamsSchema,
} from "@/api/handlers/entities/checkpoint-desktop-edit-session";
import {
  finalizeDesktopEditSessionBodySchema,
  finalizeDesktopEditSessionHandler,
  finalizeDesktopEditSessionParamsSchema,
} from "@/api/handlers/entities/finalize-desktop-edit-session";

export const desktopEditSessionsRoute = new Elysia({
  prefix: "/desktop-edit-sessions",
})
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
  );
