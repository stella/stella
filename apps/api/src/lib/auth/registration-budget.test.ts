import { PGlite } from "@electric-sql/pglite";
import { Result } from "better-result";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import { envApiServerSchema } from "@/api/env-schema";
import { reserveRegistration } from "@/api/lib/auth/registration-budget";

const limits = {
  agent: v.parse(envApiServerSchema.AGENT_REGISTRATION_DAILY_LIMIT, "3"),
  "open-client": v.parse(
    envApiServerSchema.OPEN_CLIENT_REGISTRATION_DAILY_LIMIT,
    "5",
  ),
};

test("daily registration admission is shared, bounded, and resets on the next UTC day", async () => {
  const client = new PGlite();
  await client.exec(`create table registration_daily_budget (
    day timestamptz not null, kind text not null, count integer not null, primary key (day, kind)
  )`);
  const db = drizzle({ client });
  const now = new Date("2026-10-03T12:00:00Z");
  for (const kind of ["agent", "open-client"] as const) {
    await client.query(
      "insert into registration_daily_budget values ($1, $2, $3)",
      ["2026-10-03T00:00:00Z", kind, limits[kind] - 1],
    );
    const options = {
      kind,
      limit: limits[kind],
      now,
      execute: async (query: Parameters<typeof db.execute>[0]) =>
        (await db.execute(query)).rows,
    };
    const admissions = await Promise.all([
      reserveRegistration(options),
      reserveRegistration(options),
    ]);
    expect(admissions.filter(Result.isOk)).toHaveLength(1);
    const denied = admissions.find(Result.isError);
    expect(denied?.error.status).toBe(503);
    const again = await reserveRegistration(options);
    expect(Result.isError(again)).toBe(true);
    expect(
      Result.isOk(
        await reserveRegistration({
          ...options,
          now: new Date("2026-10-04T00:00:00Z"),
        }),
      ),
    ).toBe(true);
  }
  await client.close();
});

test("unavailable registration storage returns a typed refusal", async () => {
  const admission = await reserveRegistration({
    kind: "agent",
    limit: limits.agent,
    now: new Date("2026-10-03T12:00:00Z"),
    execute: async () => {
      throw new TypeError("Storage unavailable");
    },
  });
  expect(Result.isError(admission)).toBe(true);
  if (Result.isError(admission)) {
    expect(admission.error.status).toBe(503);
  }
});
