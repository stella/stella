SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Keep the SQL search match-key fold aligned with @stll/text-normalize:
-- U+0653-U+0655 are decomposed Arabic madda/hamza marks and normalize to
-- no search-key character, matching composed alef/waw/yeh hamza folds.
CREATE OR REPLACE FUNCTION arabic_normalize(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT btrim(
    regexp_replace(
      translate(
        regexp_replace(
          normalize($1, NFKC),
          '[ـً-ٰٕ]',
          '',
          'g'
        ),
        'آأإٱؤئةى٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹ABCDEFGHIJKLMNOPQRSTUVWXYZİء',
        'ااااويهي01234567890123456789abcdefghijklmnopqrstuvwxyzi'
      ),
      U&'[ \0009\000A\000B\000C\000D\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',
      ' ',
      'g'
    )
  )
$$;
