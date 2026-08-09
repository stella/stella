import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import createExpense from "@/api/handlers/expenses/create";
import deleteExpense from "@/api/handlers/expenses/delete";
import readExpenses from "@/api/handlers/expenses/list";
import updateExpense from "@/api/handlers/expenses/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import {
  resourceRealtime,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-realtime-macro";

const expenseRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.EXPENSE,
);

export const expensesRoute = new Elysia({
  prefix: "/expenses/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(resourceRealtime)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get("/", readExpenses.handler, {
    permissions: readExpenses.config.permissions,
    query: readExpenses.config.query,
  })
  .put("/", createExpense.handler, {
    body: createExpense.config.body,
    resourceSetUpdated: expenseRealtimeUpdates,
    permissions: createExpense.config.permissions,
  })
  .patch("/", updateExpense.handler, {
    body: updateExpense.config.body,
    resourceSetUpdated: expenseRealtimeUpdates,
    permissions: updateExpense.config.permissions,
  })
  .delete("/", deleteExpense.handler, {
    body: deleteExpense.config.body,
    resourceSetUpdated: expenseRealtimeUpdates,
    permissions: deleteExpense.config.permissions,
  });
