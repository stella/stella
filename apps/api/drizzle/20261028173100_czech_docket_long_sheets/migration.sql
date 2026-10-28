SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.decision_docket_filing_year(case_number text, jurisdiction text)
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $function$
  WITH normalized AS (
    SELECT regexp_replace(btrim(regexp_replace(
      regexp_replace(normalize(coalesce(case_number, ''), NFKC), '[-\u2010-\u2015\u2212]', '-', 'g'),
      U&'[\0009\000a\000b\000c\000d\0020\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff]+', ' ', 'g')), '-[0-9]{1,4}$', '') AS folded
  )
  SELECT CASE jurisdiction
    WHEN 'AUT' THEN jsonb_build_object('type', 'none-in-format')
    WHEN 'CZE' THEN CASE
        WHEN (folded ~* '^(?:(?:pl|i|ii|iii|iv)\.? ?|\d{1,3} ?)(?:\d{1,3} ?)?[[:alpha:]]{1,7}\.? \d{1,6}\/\d{2}(?:\d{2})?(?:-\d{1,5})?$' OR folded ~ '^[[:upper:]][[:lower:]]{0,6}\.? \d{1,6}\/\d{2}(?:\d{2})?(?:-\d{1,5})?$')
          AND substring(folded FROM '/([0-9]{4})(?:-[0-9]+)?$')::integer > 0
        THEN jsonb_build_object('type', 'known', 'year', substring(folded FROM '/([0-9]{4})(?:-[0-9]+)?$')::integer)
        ELSE jsonb_build_object('type', 'unparseable') END
    WHEN 'EU' THEN jsonb_build_object('type', 'none-in-format')
    WHEN 'GBR' THEN jsonb_build_object('type', 'none-in-format')
    WHEN 'HUN' THEN jsonb_build_object('type', 'none-in-format')
    WHEN 'POL' THEN jsonb_build_object('type', 'none-in-format')
    WHEN 'SVK' THEN CASE
        WHEN (folded ~* '^(?:\d{1,3}) ?(?:[[:alpha:]]{1,7})(?: ?\/ ?| )(?:\d{1,6})\/(?:\d{4})$' OR folded ~* '^(?:pl|iv|i{1,3})(?:\. ?| )[\u00FAu]s(?: ?\/ ?| ?)(?:\d{1,5})\/(?:\d{2}|\d{4})$')
          AND substring(folded FROM '/([0-9]{4})(?:-[0-9]+)?$')::integer > 0
        THEN jsonb_build_object('type', 'known', 'year', substring(folded FROM '/([0-9]{4})(?:-[0-9]+)?$')::integer)
        ELSE jsonb_build_object('type', 'unparseable') END
    WHEN 'USA' THEN jsonb_build_object('type', 'none-in-format')
    ELSE jsonb_build_object('type', 'unparseable')
  END FROM normalized
$function$;
