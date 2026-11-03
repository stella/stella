SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- An EU VAT number lives in vat_id: tax_id holds one only beside a vat_id.
-- Added NOT VALID without scanning existing contacts; contact-vat-id-repair.ts
-- moves the stored values online and then validates it.
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_vat_id_check"
  CHECK ("vat_id" IS NOT NULL OR "tax_id" IS NULL OR upper(regexp_replace("tax_id", '[[:space:].-]', '', 'g')) !~ '^(?:AT(?:U\d{8})|BE(?:[01]\d{9})|BG(?:\d{9,10})|CY(?:\d{8}[A-Z])|CZ(?:\d{8,10})|DE(?:\d{9})|DK(?:\d{8})|EE(?:\d{9})|EL(?:\d{9})|ES(?:[0-9A-Z]\d{7}[0-9A-Z])|FI(?:\d{8})|FR(?:[0-9A-HJ-NP-Z]{2}\d{9})|HR(?:\d{11})|HU(?:\d{8})|IE(?:(?:\d{7}[A-W][A-I]?|\d[A-Z+*]\d{5}[A-W]))|IT(?:\d{11})|LT(?:(?:\d{9}|\d{12}))|LU(?:\d{8})|LV(?:\d{11})|MT(?:\d{8})|NL(?:\d{9}B\d{2})|PL(?:\d{10})|PT(?:\d{9})|RO(?:\d{2,10})|SE(?:\d{12})|SI(?:\d{8})|SK(?:\d{10})|XI(?:(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})))$') NOT VALID;
