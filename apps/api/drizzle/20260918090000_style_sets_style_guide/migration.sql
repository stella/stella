SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- The house style a style set was read into: the bound guide the conversion
-- pass applies, kept beside the package it was derived from. Nullable because
-- a set exists from the moment its package lands, before a guide has been
-- extracted from it.
--
-- No default and no NOT NULL, so the rewrite is metadata-only and no existing
-- row is read.
ALTER TABLE "style_sets"
  ADD COLUMN "style_guide" jsonb;--> statement-breakpoint

-- A guide is one object (StyleGuide in lib/house-style/guide.ts). Drizzle's
-- `$type` is compile-time only and the value arrives from the wire, so the
-- column states the rule itself. NULL satisfies the CHECK, which is the
-- not-yet-extracted state above.
--
-- NOT VALID, with no VALIDATE to follow: the column was just created, so every
-- stored row holds NULL here and a validating scan would read the whole table
-- to prove what the column definition already guarantees. The constraint
-- applies to every later INSERT and UPDATE, which is every row that can carry
-- a value.
ALTER TABLE "style_sets"
  ADD CONSTRAINT "style_sets_style_guide_shape_check"
  CHECK (jsonb_typeof("style_guide") = 'object') NOT VALID;
