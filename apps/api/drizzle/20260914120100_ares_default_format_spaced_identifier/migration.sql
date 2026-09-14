SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The ARES built-in format now groups the IČO the way Czech practice writes it
-- ("ddd dd ddd"), so its identifier token changed from [registry number] to
-- [registry number spaced].
--
-- A saved format whose text equals the old built-in string is what the
-- renderer treats as "still the built-in": leaving those rows behind would
-- freeze them on the ungrouped identifier while every unsaved lookup moved on.
-- The literals are spelled out here rather than imported: a migration has to
-- keep meaning what it meant when it ran, and the package constant will keep
-- changing.
--
-- Bounded by an exact-text match on a small configuration table, and
-- idempotent: a re-run matches nothing, because the rows it would rewrite now
-- hold the new string.
UPDATE "template_lookup_formats"
SET "format" = 'společnost **[company name]**, se sídlem [address], IČO: [registry number spaced], zapsaná v obchodním rejstříku vedeném [court instrumental] pod sp. zn. [file reference]'
WHERE "registry" = 'ares'
  AND "format" = 'společnost **[company name]**, se sídlem [address], IČO: [registry number], zapsaná v obchodním rejstříku vedeném [court instrumental] pod sp. zn. [file reference]';
