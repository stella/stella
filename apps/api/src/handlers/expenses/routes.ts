import Elysia from "elysia";

import {
  createExpenseBodySchema,
  createExpenseHandler,
} from "@/api/handlers/expenses/create";
import {
  deleteExpenseBodySchema,
  deleteExpenseHandler,
} from "@/api/handlers/expenses/delete";
import {
  readExpensesHandler,
  readExpensesQuerySchema,
} from "@/api/handlers/expenses/read";
import {
  updateExpenseBodySchema,
  updateExpenseHandler,
} from "@/api/handlers/expenses/update";
import { workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const expensesRoute = new Elysia({
  prefix: "/expenses/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get(
    "/",
    (ctx) =>
      readExpensesHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
      }),
    {
      query: readExpensesQuerySchema,
    },
  )
  .put(
    "/",
    (ctx) =>
      createExpenseHandler({
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: createExpenseBodySchema,
    },
  )
  .patch(
    "/",
    (ctx) =>
      updateExpenseHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: updateExpenseBodySchema,
    },
  )
  .delete(
    "/",
    (ctx) =>
      deleteExpenseHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: deleteExpenseBodySchema,
    },
  );
