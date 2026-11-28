import createExpense from "@/api/handlers/expenses/create";
import deleteExpense from "@/api/handlers/expenses/delete";
import readExpenses from "@/api/handlers/expenses/list";
import updateExpense from "@/api/handlers/expenses/update";
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";

export const expensesRoute = routes(
  {
    "/": {
      GET: readExpenses,
      PUT: createExpense,
      PATCH: updateExpense,
      DELETE: deleteExpense,
    },
  },
  {
    prefix: "/expenses/:workspaceId",
    deployment: { type: "flag", flag: "FEATURE_TIME_BILLING" },
    middleware: [featureAccessGate("time-billing")],
  },
);
