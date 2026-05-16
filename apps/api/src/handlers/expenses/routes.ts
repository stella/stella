import Elysia from "elysia";

import createExpense from "@/api/handlers/expenses/create";
import deleteExpense from "@/api/handlers/expenses/delete";
import readExpenses from "@/api/handlers/expenses/read";
import updateExpense from "@/api/handlers/expenses/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const expensesRoute = new Elysia({
  prefix: "/expenses/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
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
    invalidateQuery: true,
    permissions: createExpense.config.permissions,
  })
  .patch("/", updateExpense.handler, {
    body: updateExpense.config.body,
    invalidateQuery: true,
    permissions: updateExpense.config.permissions,
  })
  .delete("/", deleteExpense.handler, {
    body: deleteExpense.config.body,
    invalidateQuery: true,
    permissions: deleteExpense.config.permissions,
  });
