import Elysia from "elysia";

import { authMacro, permissionMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import adminList from "./admin/list";
import adminStop from "./admin/stop";
import confirm from "./confirm";
import discard from "./discard";
import list from "./list";
import pause from "./pause";
import resume from "./resume";
import start from "./start";
import update from "./update";

export const timeTimersRoute = new Elysia({ prefix: "/v1/time-timers" })
  .use(
    deploymentFeatureGate(() =>
      isDeploymentFeatureEnabled("FEATURE_TIME_BILLING"),
    ),
  )
  .use(featureAccessGate("time-billing"))
  .use(rateLimit(createStandardApiRateLimitOptions()))
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get(
    "/",
    {
      query: list.config.query,
      permissions: list.config.permissions,
    },
    list.handler,
  )
  .get(
    "/admin",
    {
      query: adminList.config.query,
      permissions: adminList.config.permissions,
    },
    adminList.handler,
  )
  .post(
    "/admin/:id/stop",
    {
      params: adminStop.config.params,
      body: adminStop.config.body,
      permissions: adminStop.config.permissions,
    },
    adminStop.handler,
  )
  .post(
    "/start",
    {
      body: start.config.body,
      permissions: start.config.permissions,
    },
    start.handler,
  )
  .post(
    "/:id/pause",
    {
      params: pause.config.params,
      permissions: pause.config.permissions,
    },
    pause.handler,
  )
  .post(
    "/:id/resume",
    {
      params: resume.config.params,
      permissions: resume.config.permissions,
    },
    resume.handler,
  )
  .patch(
    "/:id",
    {
      params: update.config.params,
      body: update.config.body,
      permissions: update.config.permissions,
    },
    update.handler,
  )
  .post(
    "/:id/confirm",
    {
      params: confirm.config.params,
      body: confirm.config.body,
      permissions: confirm.config.permissions,
    },
    confirm.handler,
  )
  .delete(
    "/:id",
    {
      params: discard.config.params,
      permissions: discard.config.permissions,
    },
    discard.handler,
  );
