import { panic } from "better-result";
import { expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { vatRateOnDate } from "@/api/lib/billing/vat-rates";

test("VAT date predicate binds the date to an inclusive start and exclusive nullable end", () => {
  const query = new PgDialect().sqlToQuery(
    vatRateOnDate("2026-07-01") ?? panic("Missing VAT date predicate"),
  );
  expect(query.sql).toContain('"vat_rates"."valid_from" <= $1');
  expect(query.sql).toContain('"vat_rates"."valid_to" is null');
  expect(query.sql).toContain('"vat_rates"."valid_to" > $2');
  expect(query.sql).toContain(" and ");
  expect(query.sql).toContain(" or ");
  expect(query.params).toEqual(["2026-07-01", "2026-07-01"]);
});
