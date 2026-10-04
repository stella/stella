-- requires: 20261003120300_legislation_work_names
-- requires: 20261002120400_case_law_decision_court_id
-- requires: 20260926160000_case_law_provision_extraction_state
-- requires: 20260924100000_case_law_decision_supplements
SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- New and changed plain-text values only: CHECK NOT VALID would also reject
-- unrelated updates of legacy rows. No validation scan or table rewrite.
-- Keep the predicate equal to TAG_LIKE_MARKUP_SOURCE; the real-PG property
-- test binds it to the sanitizer's detector.
CREATE FUNCTION plain_text_has_markup(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN value ~ $markup$<!--|<!\[CDATA\[|<\?[A-Za-z]|</?[A-Za-z][A-Za-z0-9:-]*([ \t\n\f\r]([^<>"']|"[^"]*"|'[^']*')*)?/?>$markup$;

-- Generated from METADATA_URL_SCHEMAS and composedMetadataUrlSchema.
-- The source identity selects the contract; values cannot select exemptions.
CREATE FUNCTION plain_text_source_url_schema(source uuid, composed boolean DEFAULT false) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path FROM CURRENT
RETURN COALESCE(
  ($url_schemas${
    "cz-regional": {"base":{},"composed":{"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "cz-ns": {"base":{},"composed":{"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "cz-nss": {"base":{},"composed":{"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "cz-us": {"base":{},"composed":{"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "sk-courts": {"base":{"referencedLegislation":{"items":{"url":"url"}}},"composed":{"referencedLegislation":{"items":{"url":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "sk-us": {"base":{},"composed":{"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "pl-courts": {"base":{"href":"url","division":{"href":"url","court":{"href":"url"},"chamber":{"object":{"href":"url"},"preserve":"opaque"}},"chambers":{"items":{"href":"url"}},"source":{"judgmentUrl":"url"},"documentSupplements":{"items":{"sourceUrl":"url"}}},"composed":{"href":"url","division":{"href":"url","court":{"href":"url"},"chamber":{"object":{"href":"url"},"preserve":"opaque"}},"chambers":{"items":{"href":"url"}},"source":{"judgmentUrl":"url"},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "pl-sn": {"base":{},"composed":{"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "pl-kio": {"base":{},"composed":{"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "pl-tk": {"base":{"caseDocuments":{"items":{"url":"url"}},"publications":{"items":{"links":{"items":{"url":"url"}}}},"wordDocumentUrl":"url"},"composed":{"caseDocuments":{"items":{"url":"url"}},"publications":{"items":{"links":{"items":{"url":"url"}}}},"wordDocumentUrl":"url","documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "pl-nsa": {"base":{"citedProvisions":{"items":{"link":"url"}},"relatedDecisions":{"items":{"sourceUrl":"url"}}},"composed":{"citedProvisions":{"items":{"link":"url"}},"relatedDecisions":{"items":{"sourceUrl":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "pl-ncourt": {"base":{"documentSupplements":{"items":{"sourceUrl":"url"}}},"composed":{"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "at-courts": {"base":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}}},"composed":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "at-vfgh": {"base":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}}},"composed":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "at-vwgh": {"base":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}}},"composed":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "at-bvwg": {"base":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}}},"composed":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "at-lvwg": {"base":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}}},"composed":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "at-asylgh": {"base":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}}},"composed":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "at-ubas": {"base":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}}},"composed":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "at-uvs": {"base":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}}},"composed":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "at-verg": {"base":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}}},"composed":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "at-umse": {"base":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}}},"composed":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "at-bks": {"base":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}}},"composed":{"decisionTextDocument":"url","documentParts":{"items":{"formats":{"items":{"url":"url"}}}},"headnotes":{"items":{"documentUrl":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "at-findok": {"base":{},"composed":{"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "eu-ecj": {"base":{"manifestationUri":"url","languageUri":"url","cdmType":"url","manifestations":{"items":{"uri":"url"}}},"composed":{"manifestationUri":"url","languageUri":"url","cdmType":"url","manifestations":{"items":{"uri":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "hu-bhgy": {"base":{},"composed":{"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "pl-kis": {"base":{"otherSourceUrl":"url","relatedDocuments":{"items":{"sourceUrl":"url"}}},"composed":{"otherSourceUrl":"url","relatedDocuments":{"items":{"sourceUrl":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "pl-uodo": {"base":{},"composed":{"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "pl-uokik": {"base":{"decisionFiles":{"items":{"documentUrl":"url"}},"appealRulings":{"items":{"documentUrl":"url"}}},"composed":{"decisionFiles":{"items":{"documentUrl":"url"}},"appealRulings":{"items":{"documentUrl":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "us-courtlistener": {"base":{},"composed":{"documentSupplements":{"items":{"sourceUrl":"url"}}}}
  }$url_schemas$::jsonb ->
    (SELECT adapter_key FROM case_law_sources WHERE id = source) ->
    CASE WHEN composed THEN 'composed' ELSE 'base' END),
  '{}'::jsonb
);

-- Only string leaves explicitly declared as URLs are exempt. Unexpected
-- objects/arrays at a URL path, sibling labels and unknown keys stay guarded.
CREATE FUNCTION plain_text_metadata_has_markup(value jsonb, url_schema jsonb DEFAULT '{}'::jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $metadata_guard$
DECLARE
  child record;
  object_schema jsonb;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'string' THEN
      RETURN url_schema IS DISTINCT FROM '"url"'::jsonb
        AND plain_text_has_markup(value #>> '{}');
    WHEN 'array' THEN
      FOR child IN SELECT element FROM jsonb_array_elements(value) AS item(element) LOOP
        IF plain_text_metadata_has_markup(child.element, url_schema -> 'items') THEN
          RETURN true;
        END IF;
      END LOOP;
    WHEN 'object' THEN
      object_schema := CASE
        WHEN url_schema ? 'items' THEN '{}'::jsonb
        WHEN url_schema ->> 'preserve' IN ('string', 'opaque') THEN url_schema -> 'object'
        ELSE url_schema
      END;
      FOR child IN SELECT key, element FROM jsonb_each(value) AS item(key, element) LOOP
        IF plain_text_metadata_has_markup(child.element, object_schema -> child.key) THEN
          RETURN true;
        END IF;
      END LOOP;
    ELSE
      RETURN false;
  END CASE;
  RETURN false;
END;
$metadata_guard$;

CREATE FUNCTION case_law_decisions_plain_text_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $guard$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.case_number IS DISTINCT FROM OLD.case_number THEN
    IF plain_text_has_markup(NEW.case_number) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'case_number';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.citation_key IS DISTINCT FROM OLD.citation_key THEN
    IF plain_text_has_markup(NEW.citation_key) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'citation_key';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.ecli IS DISTINCT FROM OLD.ecli THEN
    IF plain_text_has_markup(NEW.ecli) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'ecli';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.court IS DISTINCT FROM OLD.court THEN
    IF plain_text_has_markup(NEW.court) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'court';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.court_id IS DISTINCT FROM OLD.court_id THEN
    IF plain_text_has_markup(NEW.court_id) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'court_id';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.decision_type IS DISTINCT FROM OLD.decision_type THEN
    IF plain_text_has_markup(NEW.decision_type) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'decision_type';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.metadata IS DISTINCT FROM OLD.metadata
    OR NEW.source_id IS DISTINCT FROM OLD.source_id THEN
    IF plain_text_metadata_has_markup(NEW.metadata, plain_text_source_url_schema(NEW.source_id, true)) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'metadata';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER case_law_decisions_plain_text_guard
BEFORE INSERT OR UPDATE OF case_number, citation_key, ecli, court, court_id, decision_type, metadata, source_id ON case_law_decisions
FOR EACH ROW EXECUTE FUNCTION case_law_decisions_plain_text_guard();

CREATE FUNCTION case_law_decision_supplements_plain_text_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $guard$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.case_number IS DISTINCT FROM OLD.case_number THEN
    IF plain_text_has_markup(NEW.case_number) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'case_number';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.court IS DISTINCT FROM OLD.court THEN
    IF plain_text_has_markup(NEW.court) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'court';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.metadata IS DISTINCT FROM OLD.metadata
    OR NEW.source_id IS DISTINCT FROM OLD.source_id THEN
    IF plain_text_metadata_has_markup(NEW.metadata, plain_text_source_url_schema(NEW.source_id, false)) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'metadata';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER case_law_decision_supplements_plain_text_guard
BEFORE INSERT OR UPDATE OF case_number, court, metadata, source_id ON case_law_decision_supplements
FOR EACH ROW EXECUTE FUNCTION case_law_decision_supplements_plain_text_guard();

CREATE FUNCTION case_law_decision_identifiers_plain_text_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $guard$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.value IS DISTINCT FROM OLD.value THEN
    IF plain_text_has_markup(NEW.value) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'value';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.normalized_value IS DISTINCT FROM OLD.normalized_value THEN
    IF plain_text_has_markup(NEW.normalized_value) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'normalized_value';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER case_law_decision_identifiers_plain_text_guard
BEFORE INSERT OR UPDATE OF value, normalized_value ON case_law_decision_identifiers
FOR EACH ROW EXECUTE FUNCTION case_law_decision_identifiers_plain_text_guard();

CREATE FUNCTION case_law_judges_plain_text_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $guard$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.court IS DISTINCT FROM OLD.court THEN
    IF plain_text_has_markup(NEW.court) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'court';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.full_name IS DISTINCT FROM OLD.full_name THEN
    IF plain_text_has_markup(NEW.full_name) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'full_name';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.name_key IS DISTINCT FROM OLD.name_key THEN
    IF plain_text_has_markup(NEW.name_key) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'name_key';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.portrait_attribution IS DISTINCT FROM OLD.portrait_attribution THEN
    IF plain_text_has_markup(NEW.portrait_attribution) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'portrait_attribution';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER case_law_judges_plain_text_guard
BEFORE INSERT OR UPDATE OF court, full_name, name_key, portrait_attribution ON case_law_judges
FOR EACH ROW EXECUTE FUNCTION case_law_judges_plain_text_guard();

CREATE FUNCTION case_law_decision_judges_plain_text_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $guard$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.name_as_printed IS DISTINCT FROM OLD.name_as_printed THEN
    IF plain_text_has_markup(NEW.name_as_printed) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'name_as_printed';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.name_key IS DISTINCT FROM OLD.name_key THEN
    IF plain_text_has_markup(NEW.name_key) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'name_key';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER case_law_decision_judges_plain_text_guard
BEFORE INSERT OR UPDATE OF name_as_printed, name_key ON case_law_decision_judges
FOR EACH ROW EXECUTE FUNCTION case_law_decision_judges_plain_text_guard();

CREATE FUNCTION case_law_citations_plain_text_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $guard$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.citation_text IS DISTINCT FROM OLD.citation_text THEN
    IF plain_text_has_markup(NEW.citation_text) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'citation_text';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.citation_key IS DISTINCT FROM OLD.citation_key THEN
    IF plain_text_has_markup(NEW.citation_key) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'citation_key';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.normalized_identifier_value IS DISTINCT FROM OLD.normalized_identifier_value THEN
    IF plain_text_has_markup(NEW.normalized_identifier_value) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'normalized_identifier_value';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.cited_court_hint IS DISTINCT FROM OLD.cited_court_hint THEN
    IF plain_text_has_markup(NEW.cited_court_hint) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'cited_court_hint';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.cited_sheet_number IS DISTINCT FROM OLD.cited_sheet_number THEN
    IF plain_text_has_markup(NEW.cited_sheet_number) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'cited_sheet_number';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER case_law_citations_plain_text_guard
BEFORE INSERT OR UPDATE OF citation_text, citation_key, normalized_identifier_value, cited_court_hint, cited_sheet_number ON case_law_citations
FOR EACH ROW EXECUTE FUNCTION case_law_citations_plain_text_guard();

CREATE FUNCTION case_law_provision_citations_plain_text_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $guard$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.work_identifier IS DISTINCT FROM OLD.work_identifier THEN
    IF plain_text_has_markup(NEW.work_identifier) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'work_identifier';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.work_collection IS DISTINCT FROM OLD.work_collection THEN
    IF plain_text_has_markup(NEW.work_collection) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'work_collection';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.section_suffix IS DISTINCT FROM OLD.section_suffix THEN
    IF plain_text_has_markup(NEW.section_suffix) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'section_suffix';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.subsection IS DISTINCT FROM OLD.subsection THEN
    IF plain_text_has_markup(NEW.subsection) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'subsection';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.letter IS DISTINCT FROM OLD.letter THEN
    IF plain_text_has_markup(NEW.letter) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'letter';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.point IS DISTINCT FROM OLD.point THEN
    IF plain_text_has_markup(NEW.point) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'point';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.sentence IS DISTINCT FROM OLD.sentence THEN
    IF plain_text_has_markup(NEW.sentence) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'sentence';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.print_text IS DISTINCT FROM OLD.print_text THEN
    IF plain_text_has_markup(NEW.print_text) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'print_text';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.name_text IS DISTINCT FROM OLD.name_text THEN
    IF plain_text_has_markup(NEW.name_text) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'name_text';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.printed_work_identifier IS DISTINCT FROM OLD.printed_work_identifier THEN
    IF plain_text_has_markup(NEW.printed_work_identifier) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'printed_work_identifier';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER case_law_provision_citations_plain_text_guard
BEFORE INSERT OR UPDATE OF work_identifier, work_collection, section_suffix, subsection, letter, point, sentence, print_text, name_text, printed_work_identifier ON case_law_provision_citations
FOR EACH ROW EXECUTE FUNCTION case_law_provision_citations_plain_text_guard();

CREATE FUNCTION legislation_documents_plain_text_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $guard$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.title IS DISTINCT FROM OLD.title THEN
    IF plain_text_has_markup(NEW.title) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'title';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.document_type IS DISTINCT FROM OLD.document_type THEN
    IF plain_text_has_markup(NEW.document_type) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'document_type';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN
    IF plain_text_metadata_has_markup(NEW.metadata) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'metadata';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER legislation_documents_plain_text_guard
BEFORE INSERT OR UPDATE OF title, document_type, metadata ON legislation_documents
FOR EACH ROW EXECUTE FUNCTION legislation_documents_plain_text_guard();

CREATE FUNCTION legislation_work_names_plain_text_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $guard$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.official_title IS DISTINCT FROM OLD.official_title THEN
    IF plain_text_has_markup(NEW.official_title) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'official_title';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.derived_name IS DISTINCT FROM OLD.derived_name THEN
    IF plain_text_has_markup(NEW.derived_name) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'derived_name';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.cited_key IS DISTINCT FROM OLD.cited_key THEN
    IF plain_text_has_markup(NEW.cited_key) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'cited_key';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.match_key IS DISTINCT FROM OLD.match_key THEN
    IF plain_text_has_markup(NEW.match_key) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'match_key';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER legislation_work_names_plain_text_guard
BEFORE INSERT OR UPDATE OF official_title, derived_name, cited_key, match_key ON legislation_work_names
FOR EACH ROW EXECUTE FUNCTION legislation_work_names_plain_text_guard();

CREATE FUNCTION case_law_search_documents_plain_text_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $guard$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.title IS DISTINCT FROM OLD.title THEN
    IF plain_text_has_markup(NEW.title) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'title';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER case_law_search_documents_plain_text_guard
BEFORE INSERT OR UPDATE OF title ON case_law_search_documents
FOR EACH ROW EXECUTE FUNCTION case_law_search_documents_plain_text_guard();

CREATE FUNCTION legislation_search_documents_plain_text_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $guard$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.title IS DISTINCT FROM OLD.title THEN
    IF plain_text_has_markup(NEW.title) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'plain_text_markup_rejected',
        CONSTRAINT = 'plain_text_no_markup',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, COLUMN = 'title';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER legislation_search_documents_plain_text_guard
BEFORE INSERT OR UPDATE OF title ON legislation_search_documents
FOR EACH ROW EXECUTE FUNCTION legislation_search_documents_plain_text_guard();
