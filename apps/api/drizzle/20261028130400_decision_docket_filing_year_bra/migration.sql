SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.decision_docket_filing_year(case_number text, jurisdiction text)
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $function$
  WITH normalized AS (
    SELECT regexp_replace(btrim(regexp_replace(
      regexp_replace(normalize(coalesce(case_number, ''), NFKC), '[-\u2010-\u2015\u2212]', '-', 'g'),
      U&'[\0009\000a\000b\000c\000d\0020\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff]+', ' ', 'g')), '-[0-9]{1,4}$', '') AS folded
  )
  SELECT CASE WHEN jurisdiction = 'AUT' THEN jsonb_build_object('type', 'none-in-format')
      WHEN jurisdiction = 'BRA' THEN CASE WHEN folded ~ '^(?:[[:alpha:]][[[:alpha:]]]{0,9}(?:-[[:alpha:]][[[:alpha:]]]{0,9}){0,4} ?- ?|[[:alpha:]][[[:alpha:]]]{0,9} )?(?:\d{1,7})-(?:\d{2})\.(\d{4})\.(?:\d)\.(?:\d{2})\.(?:\d{4})$' THEN CASE
          WHEN length(substring(folded FROM '^(?:[[:alpha:]][[[:alpha:]]]{0,9}(?:-[[:alpha:]][[[:alpha:]]]{0,9}){0,4} ?- ?|[[:alpha:]][[[:alpha:]]]{0,9} )?(?:\d{1,7})-(?:\d{2})\.(\d{4})\.(?:\d)\.(?:\d{2})\.(?:\d{4})$')) = 4 AND substring(folded FROM '^(?:[[:alpha:]][[[:alpha:]]]{0,9}(?:-[[:alpha:]][[[:alpha:]]]{0,9}){0,4} ?- ?|[[:alpha:]][[[:alpha:]]]{0,9} )?(?:\d{1,7})-(?:\d{2})\.(\d{4})\.(?:\d)\.(?:\d{2})\.(?:\d{4})$')::integer > 0
          THEN jsonb_build_object('type', 'known', 'year', substring(folded FROM '^(?:[[:alpha:]][[[:alpha:]]]{0,9}(?:-[[:alpha:]][[[:alpha:]]]{0,9}){0,4} ?- ?|[[:alpha:]][[[:alpha:]]]{0,9} )?(?:\d{1,7})-(?:\d{2})\.(\d{4})\.(?:\d)\.(?:\d{2})\.(?:\d{4})$')::integer)
          ELSE jsonb_build_object('type', 'unparseable') END
      WHEN folded ~ '^(?:\d{7})(?:\d{2})(\d{4})(?:\d)(?:\d{2})(?:\d{4})$' THEN CASE
          WHEN length(substring(folded FROM '^(?:\d{7})(?:\d{2})(\d{4})(?:\d)(?:\d{2})(?:\d{4})$')) = 4 AND substring(folded FROM '^(?:\d{7})(?:\d{2})(\d{4})(?:\d)(?:\d{2})(?:\d{4})$')::integer > 0
          THEN jsonb_build_object('type', 'known', 'year', substring(folded FROM '^(?:\d{7})(?:\d{2})(\d{4})(?:\d)(?:\d{2})(?:\d{4})$')::integer)
          ELSE jsonb_build_object('type', 'unparseable') END
      WHEN folded ~* '(?i)^(?:(?:(?:EAREsp|AgInt|EREsp|AgRg|EDcl|AgR|EAg|EDv|ED|EI|MC|QO|TP) (?:nos|nas|no|na|em) )*)(?:(?:EAREsp|REspEl|AREsp|EREsp|ExeMS|REspe|SIRDR|ADPF|AImp|OACO|PUIL|RCED|REsp|ACO|ADC|ADI|ADO|AIA|AOE|APn|ARE|Cta|EAg|Ext|HDE|IDC|Inq|IUJ|Pet|PPE|PSV|Rcl|RHC|RHD|RMI|RMS|RvC|SEC|SLS|STA|STP|TPA|AC|AE|Ag|AI|AO|AP|AR|AS|CC|Cm|CR|EI|EL|EP|HC|HD|IF|MC|MI|MS|PA|RC|RE|RO|Rp|SL|SS|TP)) (?:\d{1,3}(?:\.\d{3}){1,2}|\d{1,9})(?:\/(?:(?:AC|AL|AM|AP|BA|CE|DF|ES|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)))?(?: (?:(?:terceiros|segundos|terceiro|segundo|quartos|quintos|quarto|quinto|AgRg|EDcl|AgR|EDv|Ref|ED|EI|MC|QO|RG|TP)(?:-(?:terceiros|segundos|terceiro|segundo|quartos|quintos|quarto|quinto|AgRg|EDcl|AgR|EDv|Ref|ED|EI|MC|QO|RG|TP)){0,5}))?$' THEN jsonb_build_object('type', 'none-in-format')
      ELSE jsonb_build_object('type', 'unparseable') END
      WHEN jurisdiction = 'CZE' THEN CASE WHEN folded ~* '(?i)^(?:(?:pl|i|ii|iii|iv)\.? ?|\d{1,3} ?)(?:\d{1,3} ?)?[[:alpha:]]{1,7}\.? \d{1,6}\/(\d{2}(?:\d{2})?)(?:-\d{1,4})?$' THEN CASE
          WHEN length(substring(folded FROM '(?i)^(?:(?:pl|i|ii|iii|iv)\.? ?|\d{1,3} ?)(?:\d{1,3} ?)?[[:alpha:]]{1,7}\.? \d{1,6}\/(\d{2}(?:\d{2})?)(?:-\d{1,4})?$')) = 4 AND substring(folded FROM '(?i)^(?:(?:pl|i|ii|iii|iv)\.? ?|\d{1,3} ?)(?:\d{1,3} ?)?[[:alpha:]]{1,7}\.? \d{1,6}\/(\d{2}(?:\d{2})?)(?:-\d{1,4})?$')::integer > 0
          THEN jsonb_build_object('type', 'known', 'year', substring(folded FROM '(?i)^(?:(?:pl|i|ii|iii|iv)\.? ?|\d{1,3} ?)(?:\d{1,3} ?)?[[:alpha:]]{1,7}\.? \d{1,6}\/(\d{2}(?:\d{2})?)(?:-\d{1,4})?$')::integer)
          ELSE jsonb_build_object('type', 'unparseable') END
      WHEN folded ~ '^[[:upper:]][[:lower:]]{0,6}\.? \d{1,6}\/(\d{2}(?:\d{2})?)(?:-\d{1,4})?$' THEN CASE
          WHEN length(substring(folded FROM '^[[:upper:]][[:lower:]]{0,6}\.? \d{1,6}\/(\d{2}(?:\d{2})?)(?:-\d{1,4})?$')) = 4 AND substring(folded FROM '^[[:upper:]][[:lower:]]{0,6}\.? \d{1,6}\/(\d{2}(?:\d{2})?)(?:-\d{1,4})?$')::integer > 0
          THEN jsonb_build_object('type', 'known', 'year', substring(folded FROM '^[[:upper:]][[:lower:]]{0,6}\.? \d{1,6}\/(\d{2}(?:\d{2})?)(?:-\d{1,4})?$')::integer)
          ELSE jsonb_build_object('type', 'unparseable') END
      ELSE jsonb_build_object('type', 'unparseable') END
      WHEN jurisdiction = 'EU' THEN jsonb_build_object('type', 'none-in-format')
      WHEN jurisdiction = 'GBR' THEN jsonb_build_object('type', 'none-in-format')
      WHEN jurisdiction = 'HUN' THEN jsonb_build_object('type', 'none-in-format')
      WHEN jurisdiction = 'POL' THEN jsonb_build_object('type', 'none-in-format')
      WHEN jurisdiction = 'SVK' THEN CASE WHEN folded ~* '(?i)^(?:\d{1,3}) ?(?:[[:alpha:]]{1,7})(?: ?\/ ?| )(?:\d{1,6})\/(\d{4})$' THEN CASE
          WHEN length(substring(folded FROM '(?i)^(?:\d{1,3}) ?(?:[[:alpha:]]{1,7})(?: ?\/ ?| )(?:\d{1,6})\/(\d{4})$')) = 4 AND substring(folded FROM '(?i)^(?:\d{1,3}) ?(?:[[:alpha:]]{1,7})(?: ?\/ ?| )(?:\d{1,6})\/(\d{4})$')::integer > 0
          THEN jsonb_build_object('type', 'known', 'year', substring(folded FROM '(?i)^(?:\d{1,3}) ?(?:[[:alpha:]]{1,7})(?: ?\/ ?| )(?:\d{1,6})\/(\d{4})$')::integer)
          ELSE jsonb_build_object('type', 'unparseable') END
      WHEN folded ~* '(?i)^(?:pl|iv|i{1,3})(?:\. ?| )[\u00FAu]s(?: ?\/ ?| ?)(?:\d{1,5})\/(\d{2}|\d{4})$' THEN CASE
          WHEN length(substring(folded FROM '(?i)^(?:pl|iv|i{1,3})(?:\. ?| )[\u00FAu]s(?: ?\/ ?| ?)(?:\d{1,5})\/(\d{2}|\d{4})$')) = 4 AND substring(folded FROM '(?i)^(?:pl|iv|i{1,3})(?:\. ?| )[\u00FAu]s(?: ?\/ ?| ?)(?:\d{1,5})\/(\d{2}|\d{4})$')::integer > 0
          THEN jsonb_build_object('type', 'known', 'year', substring(folded FROM '(?i)^(?:pl|iv|i{1,3})(?:\. ?| )[\u00FAu]s(?: ?\/ ?| ?)(?:\d{1,5})\/(\d{2}|\d{4})$')::integer)
          ELSE jsonb_build_object('type', 'unparseable') END
      ELSE jsonb_build_object('type', 'unparseable') END
      WHEN jurisdiction = 'USA' THEN jsonb_build_object('type', 'none-in-format')
      ELSE jsonb_build_object('type', 'unparseable') END FROM normalized
$function$;
