import Elysia from "elysia";

import createExpense from "@/api/handlers/expenses/create";
import deleteExpense from "@/api/handlers/expenses/delete";
import readExpenses from "@/api/handlers/expenses/list";
import updateExpense from "@/api/handlers/expenses/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const expensesRoute = new Elysia({
  prefix: "/expenses/:workspaceId",
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
      permissions: readExpenses.config.permissions,
      query: readExpenses.config.query,
    },
    readExpenses.handler,
  )
  .put(
    "/",
    {
      body: createExpense.config.body,
      permissions: createExpense.config.permissions,
    },
    createExpense.handler,
  )
  .patch(
    "/",
    {
      body: updateExpense.config.body,
      permissions: updateExpense.config.permissions,
    },
    updateExpense.handler,
  )
  .delete(
    "/",
    {
      body: deleteExpense.config.body,
      permissions: deleteExpense.config.permissions,
    },
    deleteExpense.handler,
  );
