SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- Billing wrote every money column as hundredths of a major unit, whatever
-- the currency's own exponent is: a ¥1,500 rate was stored as 150000 and a
-- 12.500 KWD rate as 1250. The forms, the exports, and the display now all
-- scale by the currency's exponent (`currencyMinorUnitDigits`, in
-- packages/money/src/format.ts), so the stored rows have to mean the same
-- thing: true minor units.
--
-- Only a currency whose exponent is not 2 moves. `amount * 10^(digits - 2)`
-- covers every case at once — /100 for a zero-exponent currency, x10 for a
-- three-exponent one — and rows in the overwhelmingly common 2-exponent
-- currencies are not matched by the join at all.
--
-- The exponent table is data because a migration cannot call the helper.
-- Regenerate it with `bun apps/api/scripts/print-currency-exponents.ts`,
-- which brute-forces the three-letter code space through `Intl` so the list
-- matches exactly what the helper answers for any code a row can carry.
-- 26 codes; every other well-formed code resolves to 2.
--
-- One statement per table, each joined to a 26-row list: the planner filters
-- on the currency column, so this touches only the rows that are wrong. None
-- of these tables is registered in high-volume-tables.ts.

UPDATE "time_entries" AS entry
   SET "rate_at_entry" =
       ROUND(entry."rate_at_entry" * power(10::numeric, exponent.digits - 2))::integer
  FROM (VALUES
  ('BHD', 3),
  ('BIF', 0),
  ('BYR', 0),
  ('CLF', 4),
  ('CLP', 0),
  ('DJF', 0),
  ('GNF', 0),
  ('IQD', 3),
  ('ISK', 0),
  ('JOD', 3),
  ('JPY', 0),
  ('KMF', 0),
  ('KRW', 0),
  ('KWD', 3),
  ('LYD', 3),
  ('OMR', 3),
  ('PYG', 0),
  ('RWF', 0),
  ('TND', 3),
  ('UGX', 0),
  ('UYI', 0),
  ('VND', 0),
  ('VUV', 0),
  ('XAF', 0),
  ('XOF', 0),
  ('XPF', 0)
       ) AS exponent(currency, digits)
 WHERE entry."currency" = exponent.currency;--> statement-breakpoint

-- A rate entry carries no currency of its own; its rate table names one.
UPDATE "rate_entries" AS rate
   SET "hourly_rate" =
       ROUND(rate."hourly_rate" * power(10::numeric, exponent.digits - 2))::integer
  FROM "rate_tables" AS rate_table, (VALUES
  ('BHD', 3),
  ('BIF', 0),
  ('BYR', 0),
  ('CLF', 4),
  ('CLP', 0),
  ('DJF', 0),
  ('GNF', 0),
  ('IQD', 3),
  ('ISK', 0),
  ('JOD', 3),
  ('JPY', 0),
  ('KMF', 0),
  ('KRW', 0),
  ('KWD', 3),
  ('LYD', 3),
  ('OMR', 3),
  ('PYG', 0),
  ('RWF', 0),
  ('TND', 3),
  ('UGX', 0),
  ('UYI', 0),
  ('VND', 0),
  ('VUV', 0),
  ('XAF', 0),
  ('XOF', 0),
  ('XPF', 0)
       ) AS exponent(currency, digits)
 WHERE rate."rate_table_id" = rate_table."id"
   AND rate_table."currency" = exponent.currency;--> statement-breakpoint

-- `expenses_amount_positive_check` forbids zero, and a zero-exponent currency
-- divides by a hundred, so a stored amount below 50 (under half a yen — an
-- amount the currency cannot express at all) would round to zero and abort the
-- deployment. Floor those at 1, the smallest amount the constraint admits,
-- rather than dropping the release for a value that was never representable.
UPDATE "expenses" AS expense
   SET "amount" = GREATEST(
       1,
       ROUND(expense."amount" * power(10::numeric, exponent.digits - 2))::integer
       )
  FROM (VALUES
  ('BHD', 3),
  ('BIF', 0),
  ('BYR', 0),
  ('CLF', 4),
  ('CLP', 0),
  ('DJF', 0),
  ('GNF', 0),
  ('IQD', 3),
  ('ISK', 0),
  ('JOD', 3),
  ('JPY', 0),
  ('KMF', 0),
  ('KRW', 0),
  ('KWD', 3),
  ('LYD', 3),
  ('OMR', 3),
  ('PYG', 0),
  ('RWF', 0),
  ('TND', 3),
  ('UGX', 0),
  ('UYI', 0),
  ('VND', 0),
  ('VUV', 0),
  ('XAF', 0),
  ('XOF', 0),
  ('XPF', 0)
       ) AS exponent(currency, digits)
 WHERE expense."currency" = exponent.currency;--> statement-breakpoint

UPDATE "invoices" AS invoice
   SET "total_amount" =
       ROUND(invoice."total_amount" * power(10::numeric, exponent.digits - 2))::integer
  FROM (VALUES
  ('BHD', 3),
  ('BIF', 0),
  ('BYR', 0),
  ('CLF', 4),
  ('CLP', 0),
  ('DJF', 0),
  ('GNF', 0),
  ('IQD', 3),
  ('ISK', 0),
  ('JOD', 3),
  ('JPY', 0),
  ('KMF', 0),
  ('KRW', 0),
  ('KWD', 3),
  ('LYD', 3),
  ('OMR', 3),
  ('PYG', 0),
  ('RWF', 0),
  ('TND', 3),
  ('UGX', 0),
  ('UYI', 0),
  ('VND', 0),
  ('VUV', 0),
  ('XAF', 0),
  ('XOF', 0),
  ('XPF', 0)
       ) AS exponent(currency, digits)
 WHERE invoice."currency" = exponent.currency;
