import { SYNTHETIC_SESSION_MINT_BUDGETS } from "@/api/lib/rate-limit/budget-config";
import type { RateLimitContext } from "@/api/lib/rate-limit/contracts";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

type SyntheticSessionBudgetOptions = {
  context: Pick<RateLimitContext, "increment">;
};

export const createSyntheticSessionBudget =
  ({ context }: SyntheticSessionBudgetOptions) =>
  async (): Promise<boolean> => {
    for (const [window, budget] of Object.entries(
      SYNTHETIC_SESSION_MINT_BUDGETS,
    )) {
      const { count } = await context.increment(
        `synthetic-session:${window}`,
        budget.durationMs,
      );
      if (count > budget.max) {
        return false;
      }
    }
    return true;
  };

let reserveBudget: ReturnType<typeof createSyntheticSessionBudget> | undefined;

export const reserveSyntheticSessionBudget = async (): Promise<boolean> => {
  reserveBudget ??= createSyntheticSessionBudget({
    context: new RedisRateLimitContext({ failurePolicy: "fail_closed" }),
  });
  return await reserveBudget();
};
