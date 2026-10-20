import Elysia from "elysia";

import acceptSignal from "@/api/handlers/signals/acceptances/create";
import assignSignal from "@/api/handlers/signals/assignments/create";
import countInbox from "@/api/handlers/signals/count";
import dismissSignal from "@/api/handlers/signals/dismissals/create";
import getSignal from "@/api/handlers/signals/get";
import listSignals from "@/api/handlers/signals/list";
import createRequest from "@/api/handlers/signals/requests/create";
import snoozeSignal from "@/api/handlers/signals/snoozes/create";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const signalsRoute = new Elysia({ prefix: "/signals" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get(
    "/",
    {
      query: listSignals.config.query,
      permissions: listSignals.config.permissions,
    },
    listSignals.handler,
  )
  .get(
    "/count",
    {
      query: countInbox.config.query,
      permissions: countInbox.config.permissions,
    },
    countInbox.handler,
  )
  .post(
    "/requests",
    {
      body: createRequest.config.body,
      permissions: createRequest.config.permissions,
    },
    createRequest.handler,
  )
  .get(
    "/:signalId",
    {
      params: getSignal.config.params,
      permissions: getSignal.config.permissions,
    },
    getSignal.handler,
  )
  .post(
    "/:signalId/snoozes",
    {
      params: snoozeSignal.config.params,
      body: snoozeSignal.config.body,
      permissions: snoozeSignal.config.permissions,
    },
    snoozeSignal.handler,
  )
  .post(
    "/:signalId/dismissals",
    {
      params: dismissSignal.config.params,
      body: dismissSignal.config.body,
      permissions: dismissSignal.config.permissions,
    },
    dismissSignal.handler,
  )
  .post(
    "/:signalId/assignments",
    {
      params: assignSignal.config.params,
      body: assignSignal.config.body,
      permissions: assignSignal.config.permissions,
    },
    assignSignal.handler,
  )
  .post(
    "/:signalId/acceptances",
    {
      params: acceptSignal.config.params,
      body: acceptSignal.config.body,
      permissions: acceptSignal.config.permissions,
    },
    acceptSignal.handler,
  );
