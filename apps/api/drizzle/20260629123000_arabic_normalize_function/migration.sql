SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Search match-key fold for Arabic. Must stay byte-for-byte equal to
-- @stll/text-normalize's normalizeSearchText (golden vectors pin both).
-- NFKC folds presentation forms; the regexp strips tatweel (U+0640), the
-- eight harakat (U+064B-0652) and superscript alef (U+0670); translate
-- folds alef/hamza/teh-marbuta/yeh variants and Arabic-Indic digits,
-- deleting the trailing standalone hamza (no counterpart in the target).
CREATE OR REPLACE FUNCTION arabic_normalize(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT btrim(
    regexp_replace(
      lower(
        translate(
          regexp_replace(
            normalize($1, NFKC),
            '[ـً-ْٰ]',
            '',
            'g'
          ),
          'آأإٱؤئةى٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹ء',
          'ااااويهي01234567890123456789'
        )
      ),
      '\s+', ' ', 'g'
    )
  )
$$;
