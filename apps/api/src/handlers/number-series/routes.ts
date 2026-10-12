import Elysia from "elysia";

import archiveNumberSeries from "@/api/handlers/number-series/archive";
import createNumberSeries from "@/api/handlers/number-series/create";
import updateNumberSeriesDefault from "@/api/handlers/number-series/default/update";
import getNumberSeries from "@/api/handlers/number-series/get";
import listNumberSeries from "@/api/handlers/number-series/list";
import previewNumberSeries from "@/api/handlers/number-series/preview";
import updateNumberSeries from "@/api/handlers/number-series/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const numberSeriesRoute = new Elysia({ prefix: "/number-series" })
  .use(
    deploymentFeatureGate(() =>
      isDeploymentFeatureEnabled("FEATURE_TIME_BILLING"),
    ),
  )
  .use(featureAccessGate("time-billing"))
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listNumberSeries.handler, {
    permissions: listNumberSeries.config.permissions,
    accountAccess: listNumberSeries.config.accountAccess,
    query: listNumberSeries.config.query,
  })
  .post("/", createNumberSeries.handler, {
    permissions: createNumberSeries.config.permissions,
    accountAccess: createNumberSeries.config.accountAccess,
    body: createNumberSeries.config.body,
  })
  .get("/:numberSeriesId", getNumberSeries.handler, {
    permissions: getNumberSeries.config.permissions,
    accountAccess: getNumberSeries.config.accountAccess,
    params: getNumberSeries.config.params,
  })
  .get("/:numberSeriesId/preview", previewNumberSeries.handler, {
    permissions: previewNumberSeries.config.permissions,
    accountAccess: previewNumberSeries.config.accountAccess,
    params: previewNumberSeries.config.params,
    query: previewNumberSeries.config.query,
  })
  .patch("/:numberSeriesId", updateNumberSeries.handler, {
    permissions: updateNumberSeries.config.permissions,
    accountAccess: updateNumberSeries.config.accountAccess,
    params: updateNumberSeries.config.params,
    body: updateNumberSeries.config.body,
  })
  .post("/:numberSeriesId/default", updateNumberSeriesDefault.handler, {
    permissions: updateNumberSeriesDefault.config.permissions,
    accountAccess: updateNumberSeriesDefault.config.accountAccess,
    params: updateNumberSeriesDefault.config.params,
  })
  .post("/:numberSeriesId/archive", archiveNumberSeries.handler, {
    permissions: archiveNumberSeries.config.permissions,
    accountAccess: archiveNumberSeries.config.accountAccess,
    params: archiveNumberSeries.config.params,
  });
