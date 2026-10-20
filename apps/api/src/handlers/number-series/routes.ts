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
  .get(
    "/",
    {
      permissions: listNumberSeries.config.permissions,
      query: listNumberSeries.config.query,
    },
    listNumberSeries.handler,
  )
  .post(
    "/",
    {
      permissions: createNumberSeries.config.permissions,
      body: createNumberSeries.config.body,
    },
    createNumberSeries.handler,
  )
  .get(
    "/:numberSeriesId",
    {
      permissions: getNumberSeries.config.permissions,
      params: getNumberSeries.config.params,
    },
    getNumberSeries.handler,
  )
  .get(
    "/:numberSeriesId/preview",
    {
      permissions: previewNumberSeries.config.permissions,
      params: previewNumberSeries.config.params,
      query: previewNumberSeries.config.query,
    },
    previewNumberSeries.handler,
  )
  .patch(
    "/:numberSeriesId",
    {
      permissions: updateNumberSeries.config.permissions,
      params: updateNumberSeries.config.params,
      body: updateNumberSeries.config.body,
    },
    updateNumberSeries.handler,
  )
  .post(
    "/:numberSeriesId/default",
    {
      permissions: updateNumberSeriesDefault.config.permissions,
      params: updateNumberSeriesDefault.config.params,
    },
    updateNumberSeriesDefault.handler,
  )
  .post(
    "/:numberSeriesId/archive",
    {
      permissions: archiveNumberSeries.config.permissions,
      params: archiveNumberSeries.config.params,
    },
    archiveNumberSeries.handler,
  );
