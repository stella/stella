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
  .get(
    "/",
    {
      permissions: readTimeEntries.config.permissions,
      query: readTimeEntries.config.query,
    },
    readTimeEntries.handler,
  )
  .get(
    "/summary",
    {
      permissions: readTimeEntrySummary.config.permissions,
      query: readTimeEntrySummary.config.query,
    },
    readTimeEntrySummary.handler,
  )
  .get(
    "/suggestions",
    {
      permissions: listTimeSuggestions.config.permissions,
      query: listTimeSuggestions.config.query,
    },
    listTimeSuggestions.handler,
  )
  .post(
    "/suggestions/decisions",
    {
      body: createTimeSuggestionDecision.config.body,
      permissions: createTimeSuggestionDecision.config.permissions,
    },
    createTimeSuggestionDecision.handler,
  )
  .get(
    "/:id",
    {
      params: readTimeEntryById.config.params,
      permissions: readTimeEntryById.config.permissions,
    },
    readTimeEntryById.handler,
  )
  .put(
    "/",
    {
      body: createTimeEntry.config.body,
      permissions: createTimeEntry.config.permissions,
    },
    createTimeEntry.handler,
  )
  .patch(
    "/",
    {
      body: updateTimeEntryById.config.body,
      permissions: updateTimeEntryById.config.permissions,
    },
    updateTimeEntryById.handler,
  )
  .delete(
    "/",
    {
      body: deleteTimeEntryById.config.body,
      permissions: deleteTimeEntryById.config.permissions,
    },
    deleteTimeEntryById.handler,
  )
  .post(
    "/batch",
    {
      body: batchUpdate.config.body,
      permissions: batchUpdate.config.permissions,
    },
    batchUpdate.handler,
  )
  .delete(
    "/batch",
    {
      body: batchDelete.config.body,
      permissions: batchDelete.config.permissions,
    },
    batchDelete.handler,
  )
  .post(
    "/split",
    {
      body: splitEntry.config.body,
      permissions: splitEntry.config.permissions,
    },
    splitEntry.handler,
  )
  .get(
    "/export/csv",
    {
      permissions: exportCsv.config.permissions,
      query: exportCsv.config.query,
    },
    exportCsv.handler,
  )
  .get(
    "/export/ledes",
    {
      permissions: exportLedes.config.permissions,
      query: exportLedes.config.query,
    },
    exportLedes.handler,
  )
  .get(
    "/export/pdf",
    {
      permissions: exportPdf.config.permissions,
      query: exportPdf.config.query,
    },
    exportPdf.handler,
  )
  .post(
    "/polish-narrative",
    {
      body: polishTimeEntryNarrative.config.body,
      permissions: polishTimeEntryNarrative.config.permissions,
    },
    polishTimeEntryNarrative.handler,
  );
