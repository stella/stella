SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The physical corpus-index id of a case-law decision, derived in one place.
--
-- USA joins the declaration with an index of its own. Everything else in the
-- body is as 20260918210000_case_law_corpus_index_groups_hun left it, and the
-- ids every previously declared jurisdiction derives are unchanged.
--
-- Up to generation `case_law_v2` the id is `<generation>_<country>`, one
-- index per jurisdiction. From `case_law_v3` on it is `<generation>_<group>`,
-- where the group is the jurisdiction's entry in `CASE_LAW_INDEX_GROUP_OF`
-- (apps/api/src/lib/legal-search/case-law-index-groups.ts): CZE and SVK share
-- `cs_sk`; AUT, EU, HUN, POL, and USA each keep an index named by their own
-- lowercase code, and so does any other country. Every declared jurisdiction is
-- listed, an index of its own included, so the function reads as the
-- declaration. A shared group's name contains an underscore and a country code
-- holds letters only, so a country outside the list never lands in a shared
-- group. The generation order is compared in numeric within the integer range
-- of the backfill checkpoint's `generation_order` column; a longer digit run is
-- not a case-law generation and stays per country rather than failing a cast.
-- The body below is the rendering of that declaration;
-- `case-law-index-groups.db.test.ts` checks the function, the query fragment,
-- and `corpusIndexId` against each other. Ids already stored for `case_law_v1`
-- and `case_law_v2` are unchanged by this rule.
--
-- IMMUTABLE and STRICT: the result depends on its two arguments alone, and a
-- NULL argument yields NULL, the same as the concatenation it replaces.
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
    WHEN 'CZE' THEN 'cs_sk'
    WHEN 'EU' THEN 'eu'
    WHEN 'HUN' THEN 'hun'
    WHEN 'POL' THEN 'pol'
    WHEN 'SVK' THEN 'cs_sk'
    WHEN 'USA' THEN 'usa'
    ELSE lower(country)
  END
  ELSE generation || '_' || lower(country)
END
$function$;
