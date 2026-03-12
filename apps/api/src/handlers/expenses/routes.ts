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
  .get(
    "/",
    async (ctx) =>
      await readExpensesHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    {
      query: readExpensesQuerySchema,
    },
  )
  .put(
    "/",
    async (ctx) =>
      await createExpenseHandler({
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { expense: ["create"] },
      invalidateQuery: true,
      body: createExpenseBodySchema,
    },
  )
  .patch(
    "/",
    async (ctx) =>
      await updateExpenseHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { expense: ["update"] },
      invalidateQuery: true,
      body: updateExpenseBodySchema,
    },
  )
  .delete(
    "/",
    async (ctx) =>
      await deleteExpenseHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { expense: ["delete"] },
      invalidateQuery: true,
      body: deleteExpenseBodySchema,
    },
  );
