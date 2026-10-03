import { Result } from "better-result";
import { sql, type SQL } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import type { REGISTRATION_BUDGET_KINDS } from "@/api/db/registration-budget-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type ReserveRegistrationOptions = {
  kind: (typeof REGISTRATION_BUDGET_KINDS)[number];
  limit: number;
  now: Date;
  execute: (query: SQL) => PromiseLike<{ length: number }>;
};

export const reserveRegistration = async ({
  kind,
  limit,
  now,
  execute,
}: ReserveRegistrationOptions) => {
  const day = new Date(Math.floor(now.getTime() / DAY_IN_MS) * DAY_IN_MS);
  const reserved = await Result.tryPromise({
    try: async () =>
      await execute(sql`
      insert into registration_daily_budget (day, kind, count)
      values (${day.toISOString()}::timestamptz, ${kind}, 1)
      on conflict (day, kind) do update
      set count = registration_daily_budget.count + 1
      where registration_daily_budget.count < ${limit}
      returning count
    `),
    catch: (cause) =>
      new HandlerError({
        status: 503,
        message: "Registration is temporarily unavailable.",
        cause,
      }),
  });
  if (Result.isError(reserved)) {
    return Result.err(reserved.error);
  }
  if (reserved.value.length === 0) {
    return Result.err(
      new HandlerError({
        status: 503,
        message: "Registration is temporarily unavailable.",
      }),
    );
  }
  return Result.ok(undefined);
};
