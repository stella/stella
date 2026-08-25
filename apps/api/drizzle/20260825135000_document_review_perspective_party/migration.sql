SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- The side a comparison is judged for is now one of the target's own parties
-- ({"type":"party","role":...,"name":...}) or no side ({"type":"neutral"}),
-- where it used to be a fixed buyer/seller/neutral word.
UPDATE "document_review_runs"
SET "basis" = "basis" || jsonb_build_object(
  'perspective',
  CASE "basis" ->> 'perspective'
    WHEN 'buyer' THEN '{"type":"party","role":"Buyer","name":null}'::jsonb
    WHEN 'seller' THEN '{"type":"party","role":"Seller","name":null}'::jsonb
    ELSE '{"type":"neutral"}'::jsonb
  END
)
WHERE "basis" ->> 'type' IN ('references', 'combined')
  AND jsonb_typeof("basis" -> 'perspective') = 'string';
