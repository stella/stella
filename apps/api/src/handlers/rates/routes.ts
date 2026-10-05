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
  .get("/arrangement", readBillingArrangement.handler, {
    permissions: readBillingArrangement.config.permissions,
  })
  .put("/arrangement", setBillingArrangement.handler, {
    permissions: setBillingArrangement.config.permissions,
    body: setBillingArrangement.config.body,
  })
  .get("/summary", readMatterBillingSummary.handler, {
    permissions: readMatterBillingSummary.config.permissions,
  })
  // Rate tables
  .get("/", readRateTables.handler, {
    permissions: readRateTables.config.permissions,
    query: readRateTables.config.query,
  })
  .put("/", createRateTable.handler, {
    body: createRateTable.config.body,
    permissions: createRateTable.config.permissions,
  })
  .patch("/", updateRateTable.handler, {
    body: updateRateTable.config.body,
    permissions: updateRateTable.config.permissions,
  })
  .delete("/", deleteRateTable.handler, {
    body: deleteRateTable.config.body,
    permissions: deleteRateTable.config.permissions,
  })
  // Rate resolution
  .get("/resolve", resolveRate.handler, {
    permissions: resolveRate.config.permissions,
    query: resolveRate.config.query,
  })
  // Rate entries
  .get("/:rateTableId/entries", readRateEntries.handler, {
    params: readRateEntries.config.params,
    permissions: readRateEntries.config.permissions,
    query: readRateEntries.config.query,
  })
  .put("/:rateTableId/entries", createRateEntry.handler, {
    body: createRateEntry.config.body,
    params: createRateEntry.config.params,
    permissions: createRateEntry.config.permissions,
  })
  .patch("/:rateTableId/entries", updateRateEntry.handler, {
    body: updateRateEntry.config.body,
    params: updateRateEntry.config.params,
    permissions: updateRateEntry.config.permissions,
  })
  .delete("/:rateTableId/entries", deleteRateEntry.handler, {
    body: deleteRateEntry.config.body,
    params: deleteRateEntry.config.params,
    permissions: deleteRateEntry.config.permissions,
  });
