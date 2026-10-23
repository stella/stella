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
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const ratesRoute = routes(
  {
    "/arrangement": { GET: readBillingArrangement, PUT: setBillingArrangement },
    "/summary": { GET: readMatterBillingSummary },
    "/": {
      GET: readRateTables,
      PUT: createRateTable,
      PATCH: updateRateTable,
      DELETE: deleteRateTable,
    },
    "/resolve": { GET: resolveRate },
    "/:rateTableId/entries": {
      GET: readRateEntries,
      PUT: createRateEntry,
      PATCH: updateRateEntry,
      DELETE: deleteRateEntry,
    },
  },
  {
    prefix: "/rates/:workspaceId",
    middleware: [
      deploymentFeatureGate("FEATURE_TIME_BILLING"),
      featureAccessGate("time-billing"),
    ],
  },
);
