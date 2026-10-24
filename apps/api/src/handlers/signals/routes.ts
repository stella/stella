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
  .get("/", listSignals.handler, {
    query: listSignals.config.query,
    permissions: listSignals.config.permissions,
    accountAccess: listSignals.config.accountAccess,
  })
  .get("/count", countInbox.handler, {
    query: countInbox.config.query,
    permissions: countInbox.config.permissions,
    accountAccess: countInbox.config.accountAccess,
  })
  .post("/requests", createRequest.handler, {
    body: createRequest.config.body,
    permissions: createRequest.config.permissions,
    accountAccess: createRequest.config.accountAccess,
  })
  .get("/:signalId", getSignal.handler, {
    params: getSignal.config.params,
    permissions: getSignal.config.permissions,
    accountAccess: getSignal.config.accountAccess,
  })
  .post("/:signalId/snoozes", snoozeSignal.handler, {
    params: snoozeSignal.config.params,
    body: snoozeSignal.config.body,
    permissions: snoozeSignal.config.permissions,
    accountAccess: snoozeSignal.config.accountAccess,
  })
  .post("/:signalId/dismissals", dismissSignal.handler, {
    params: dismissSignal.config.params,
    body: dismissSignal.config.body,
    permissions: dismissSignal.config.permissions,
    accountAccess: dismissSignal.config.accountAccess,
  })
  .post("/:signalId/assignments", assignSignal.handler, {
    params: assignSignal.config.params,
    body: assignSignal.config.body,
    permissions: assignSignal.config.permissions,
    accountAccess: assignSignal.config.accountAccess,
  })
  .post("/:signalId/acceptances", acceptSignal.handler, {
    params: acceptSignal.config.params,
    body: acceptSignal.config.body,
    permissions: acceptSignal.config.permissions,
    accountAccess: acceptSignal.config.accountAccess,
  });
