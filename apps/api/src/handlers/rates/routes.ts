import Elysia from "elysia";

import readBillingArrangement from "@/api/handlers/rates/arrangement/get";
import readMatterBillingSummary from "@/api/handlers/rates/arrangement/summary/get";
import setBillingArrangement from "@/api/handlers/rates/arrangement/update";
import createRateTable from "@/api/handlers/rates/create";
import deleteRateTable from "@/api/handlers/rates/delete";
import createRateEntry from "@/api/handlers/rates/entries/create";
import deleteRateEntry from "@/api/handlers/rates/entries/delete";
import readRateEntries from "@/api/handlers/rates/entries/list";
import updateRateEntry from "@/api/handlers/rates/entries/update";
import readRateTables from "@/api/handlers/rates/list";
import resolveRate from "@/api/handlers/rates/resolve";
import updateRateTable from "@/api/handlers/rates/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const ratesRoute = new Elysia({
  prefix: "/rates/:workspaceId",
})
  .use(
    deploymentFeatureGate(() =>
      isDeploymentFeatureEnabled("FEATURE_TIME_BILLING"),
    ),
  )
  .use(featureAccessGate("time-billing"))
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get(
    "/arrangement",
    {
      permissions: readBillingArrangement.config.permissions,
    },
    readBillingArrangement.handler,
  )
  .put(
    "/arrangement",
    {
      permissions: setBillingArrangement.config.permissions,
      body: setBillingArrangement.config.body,
    },
    setBillingArrangement.handler,
  )
  .get(
    "/summary",
    {
      permissions: readMatterBillingSummary.config.permissions,
    },
    readMatterBillingSummary.handler,
  )
  // Rate tables
  .get(
    "/",
    {
      permissions: readRateTables.config.permissions,
      query: readRateTables.config.query,
    },
    readRateTables.handler,
  )
  .put(
    "/",
    {
      body: createRateTable.config.body,
      permissions: createRateTable.config.permissions,
    },
    createRateTable.handler,
  )
  .patch(
    "/",
    {
      body: updateRateTable.config.body,
      permissions: updateRateTable.config.permissions,
    },
    updateRateTable.handler,
  )
  .delete(
    "/",
    {
      body: deleteRateTable.config.body,
      permissions: deleteRateTable.config.permissions,
    },
    deleteRateTable.handler,
  )
  // Rate resolution
  .get(
    "/resolve",
    {
      permissions: resolveRate.config.permissions,
      query: resolveRate.config.query,
    },
    resolveRate.handler,
  )
  // Rate entries
  .get(
    "/:rateTableId/entries",
    {
      params: readRateEntries.config.params,
      permissions: readRateEntries.config.permissions,
      query: readRateEntries.config.query,
    },
    readRateEntries.handler,
  )
  .put(
    "/:rateTableId/entries",
    {
      body: createRateEntry.config.body,
      params: createRateEntry.config.params,
      permissions: createRateEntry.config.permissions,
    },
    createRateEntry.handler,
  )
  .patch(
    "/:rateTableId/entries",
    {
      body: updateRateEntry.config.body,
      params: updateRateEntry.config.params,
      permissions: updateRateEntry.config.permissions,
    },
    updateRateEntry.handler,
  )
  .delete(
    "/:rateTableId/entries",
    {
      body: deleteRateEntry.config.body,
      params: deleteRateEntry.config.params,
      permissions: deleteRateEntry.config.permissions,
    },
    deleteRateEntry.handler,
  );
