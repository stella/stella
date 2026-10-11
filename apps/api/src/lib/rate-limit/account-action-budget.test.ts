import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { admitAccountExportRequest } from "@/api/lib/rate-limit/account-action-budget";

describe("account export request budget", () => {
  test("accepts the last available request and refuses exhausted counters", async () => {
    const completed: string[] = [];
    const incremented: string[] = [];
    const userId = toSafeId<"user">("budget_account");
    const maximum = 3;
    const increment = (count: number) => (key: string) => {
      incremented.push(key);
      return { count, start: 0, nextReset: new Date("2030-01-01") };
    };
    const complete = (key: string) => {
      completed.push(key);
    };
    const admitted = await admitAccountExportRequest({
      userId,
      max: maximum,
      durationMs: 1000,
      context: { increment: increment(maximum), complete },
    });
    expect(Result.isOk(admitted)).toBe(true);
    const refused = await admitAccountExportRequest({
      userId,
      max: maximum,
      durationMs: 1000,
      context: { increment: increment(maximum + 1), complete },
    });
    expect(Result.isError(refused) ? refused.error : null).toMatchObject({
      status: 429,
      code: "account_export_request_limited",
    });
    expect(completed).toEqual(incremented);
    expect(incremented).toHaveLength(2);
  });
});
