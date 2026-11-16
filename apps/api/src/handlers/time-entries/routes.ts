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
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const timeEntriesRoute = routes(
  {
    "/": {
      GET: readTimeEntries,
      PUT: createTimeEntry,
      PATCH: updateTimeEntryById,
      DELETE: deleteTimeEntryById,
    },
    "/summary": { GET: readTimeEntrySummary },
    "/suggestions": { GET: listTimeSuggestions },
    "/suggestions/decisions": { POST: createTimeSuggestionDecision },
    "/:id": { GET: readTimeEntryById },
    "/batch": { POST: batchUpdate, DELETE: batchDelete },
    "/split": { POST: splitEntry },
    "/export/csv": { GET: exportCsv },
    "/export/ledes": { GET: exportLedes },
    "/export/pdf": { GET: exportPdf },
    "/polish-narrative": { POST: polishTimeEntryNarrative },
  },
  {
    prefix: "/time-entries/:workspaceId",
    middleware: [
      deploymentFeatureGate("FEATURE_TIME_BILLING"),
      featureAccessGate("time-billing"),
    ],
  },
);
