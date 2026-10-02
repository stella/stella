import { expect, test } from "bun:test";
import * as v from "valibot";

import { DAY_IN_MS } from "@stll/time";

import { envApiServerSchema } from "./env-schema";

test("accepted retention settings keep cutoff timestamps in positive ISO years", () => {
  const now = new Date("2021-03-04T10:00:00Z");
  for (const days of [1, 17, 365_000]) {
    const parsed = v.safeParse(
      envApiServerSchema.ACTION_COST_RETENTION_DAYS,
      String(days),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.output !== undefined) {
      const cutoff = new Date(now.getTime() - parsed.output * DAY_IN_MS);
      expect(cutoff.getUTCFullYear()).toBeGreaterThan(0);
      expect(cutoff.toISOString()).toMatch(/^\d{4}-/u);
    }
  }
  for (const invalid of ["0", "-1", "1.2", "100000000"]) {
    expect(
      v.safeParse(envApiServerSchema.ACTION_COST_RETENTION_DAYS, invalid)
        .success,
    ).toBe(false);
  }
});

test("Microsoft claim configuration defaults to disabled", () => {
  const schema = envApiServerSchema.MICROSOFT_REQUIRE_VERIFIED_EMAIL_CLAIM;
  expect(v.parse(schema, undefined)).toBe(false);
  expect(v.parse(schema, "false")).toBe(false);
  expect(v.parse(schema, "true")).toBe(true);
  expect(v.safeParse(schema, "invalid").success).toBe(false);
});
