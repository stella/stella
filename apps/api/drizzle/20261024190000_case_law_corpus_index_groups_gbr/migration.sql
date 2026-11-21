SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- GBR has its own group; existing jurisdiction and generation ids are unchanged.
CREATE OR REPLACE FUNCTION case_law_corpus_index_id(generation text, country text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT
AS $function$
  SELECT CASE
  WHEN substring(generation from '^case_law_v([1-9][0-9]*)$')::numeric
       BETWEEN 3
       AND 2147483647
  THEN generation || '_' || CASE upper(country)
    WHEN 'AUT' THEN 'aut'
    WHEN 'CZE' THEN CASE WHEN substring(generation from '^case_law_v([1-9][0-9]*)$')::numeric >= 9 THEN 'cze' ELSE 'cs_sk' END
    WHEN 'EU' THEN 'eu'
    WHEN 'GBR' THEN 'gbr'
    WHEN 'HUN' THEN 'hun'
    WHEN 'POL' THEN 'pol'
    WHEN 'SVK' THEN 'cs_sk'
    WHEN 'USA' THEN 'usa'
    ELSE lower(country)
  END
  ELSE generation || '_' || lower(country)
END
$function$;
