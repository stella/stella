import { createAuthRequestBudget } from "@/api/lib/rate-limit/auth-request-budget";

/** Better Auth consumes quota denials through rejected APIError values. */
export const createAuthRequestBudgetHook = (
  options: Parameters<typeof createAuthRequestBudget>[0],
) => {
  const checkBudget = createAuthRequestBudget(options);
  return async (ctx: Parameters<typeof checkBudget>[0]) => {
    const budget = await checkBudget(ctx);
    if (budget.isErr()) {
      throw budget.error;
    }
  };
};
