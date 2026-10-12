import Elysia from "elysia";

import batchDelete from "@/api/handlers/time-entries/batch/delete";
import batchUpdate from "@/api/handlers/time-entries/batch/update";
import createTimeEntry from "@/api/handlers/time-entries/create";
import exportCsv from "@/api/handlers/time-entries/csv/export";
import deleteTimeEntryById from "@/api/handlers/time-entries/delete";
import readTimeEntryById from "@/api/handlers/time-entries/get";
import exportLedes from "@/api/handlers/time-entries/ledes/export";
import readTimeEntries from "@/api/handlers/time-entries/list";
import exportPdf from "@/api/handlers/time-entries/pdf/export";
import polishTimeEntryNarrative from "@/api/handlers/time-entries/polish-narrative";
import splitEntry from "@/api/handlers/time-entries/split";
import createTimeSuggestionDecision from "@/api/handlers/time-entries/suggestions/decisions/create";
import listTimeSuggestions from "@/api/handlers/time-entries/suggestions/list";
import readTimeEntrySummary from "@/api/handlers/time-entries/summary/get";
import updateTimeEntryById from "@/api/handlers/time-entries/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const timeEntriesRoute = new Elysia({
  prefix: "/time-entries/:workspaceId",
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
  .get("/", readTimeEntries.handler, {
    permissions: readTimeEntries.config.permissions,
    accountAccess: readTimeEntries.config.accountAccess,
    query: readTimeEntries.config.query,
  })
  .get("/summary", readTimeEntrySummary.handler, {
    permissions: readTimeEntrySummary.config.permissions,
    accountAccess: readTimeEntrySummary.config.accountAccess,
    query: readTimeEntrySummary.config.query,
  })
  .get("/suggestions", listTimeSuggestions.handler, {
    permissions: listTimeSuggestions.config.permissions,
    accountAccess: listTimeSuggestions.config.accountAccess,
    query: listTimeSuggestions.config.query,
  })
  .post("/suggestions/decisions", createTimeSuggestionDecision.handler, {
    body: createTimeSuggestionDecision.config.body,
    permissions: createTimeSuggestionDecision.config.permissions,
    accountAccess: createTimeSuggestionDecision.config.accountAccess,
  })
  .get("/:id", readTimeEntryById.handler, {
    params: readTimeEntryById.config.params,
    permissions: readTimeEntryById.config.permissions,
    accountAccess: readTimeEntryById.config.accountAccess,
  })
  .put("/", createTimeEntry.handler, {
    body: createTimeEntry.config.body,
    permissions: createTimeEntry.config.permissions,
    accountAccess: createTimeEntry.config.accountAccess,
  })
  .patch("/", updateTimeEntryById.handler, {
    body: updateTimeEntryById.config.body,
    permissions: updateTimeEntryById.config.permissions,
    accountAccess: updateTimeEntryById.config.accountAccess,
  })
  .delete("/", deleteTimeEntryById.handler, {
    body: deleteTimeEntryById.config.body,
    permissions: deleteTimeEntryById.config.permissions,
    accountAccess: deleteTimeEntryById.config.accountAccess,
  })
  .post("/batch", batchUpdate.handler, {
    body: batchUpdate.config.body,
    permissions: batchUpdate.config.permissions,
    accountAccess: batchUpdate.config.accountAccess,
  })
  .delete("/batch", batchDelete.handler, {
    body: batchDelete.config.body,
    permissions: batchDelete.config.permissions,
    accountAccess: batchDelete.config.accountAccess,
  })
  .post("/split", splitEntry.handler, {
    body: splitEntry.config.body,
    permissions: splitEntry.config.permissions,
    accountAccess: splitEntry.config.accountAccess,
  })
  .get("/export/csv", exportCsv.handler, {
    permissions: exportCsv.config.permissions,
    accountAccess: exportCsv.config.accountAccess,
    query: exportCsv.config.query,
  })
  .get("/export/ledes", exportLedes.handler, {
    permissions: exportLedes.config.permissions,
    accountAccess: exportLedes.config.accountAccess,
    query: exportLedes.config.query,
  })
  .get("/export/pdf", exportPdf.handler, {
    permissions: exportPdf.config.permissions,
    accountAccess: exportPdf.config.accountAccess,
    query: exportPdf.config.query,
  })
  .post("/polish-narrative", polishTimeEntryNarrative.handler, {
    body: polishTimeEntryNarrative.config.body,
    permissions: polishTimeEntryNarrative.config.permissions,
    accountAccess: polishTimeEntryNarrative.config.accountAccess,
    requiresUsage: polishTimeEntryNarrative.config.requiresUsage,
  });
