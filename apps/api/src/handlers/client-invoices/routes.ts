import Elysia from "elysia";

import createClientInvoice from "@/api/handlers/client-invoices/create";
import prefillClientInvoice from "@/api/handlers/client-invoices/prefill";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const clientInvoicesRoute = new Elysia({
  prefix: "/client-invoices/:clientId",
})
  .use(
    deploymentFeatureGate(() =>
      isDeploymentFeatureEnabled("FEATURE_TIME_BILLING"),
    ),
  )
  .use(featureAccessGate("time-billing"))
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/prefill", prefillClientInvoice.handler, {
    params: prefillClientInvoice.config.params,
    query: prefillClientInvoice.config.query,
    permissions: prefillClientInvoice.config.permissions,
    accountAccess: prefillClientInvoice.config.accountAccess,
  })
  .put("/", createClientInvoice.handler, {
    params: createClientInvoice.config.params,
    body: createClientInvoice.config.body,
    permissions: createClientInvoice.config.permissions,
    accountAccess: createClientInvoice.config.accountAccess,
  });
