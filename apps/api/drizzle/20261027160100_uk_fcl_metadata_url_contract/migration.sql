-- requires: 20261020093000_cz_uohs_metadata_url_contract
SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- Generated from METADATA_URL_SCHEMAS and composedMetadataUrlSchema: the
-- UK source declares its composed URL-bearing metadata. Replacing the function
-- changes no table, trigger or stored row; the source identity still
-- selects the contract, so values cannot select exemptions.
CREATE OR REPLACE FUNCTION plain_text_source_url_schema(source uuid, composed boolean DEFAULT false) RETURNS jsonb
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
    "us-courtlistener": {"base":{},"composed":{"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "uk-fcl": {"base":{},"composed":{"documentSupplements":{"items":{"sourceUrl":"url"}}}},
    "cz-uohs": {"base":{"instance":{"items":"url"},"department":{"items":"url"},"proceedingTypes":{"items":"url"},"decisionTypes":{"items":"url"},"documents":{"items":{"url":"url"}}},"composed":{"instance":{"items":"url"},"department":{"items":"url"},"proceedingTypes":{"items":"url"},"decisionTypes":{"items":"url"},"documents":{"items":{"url":"url"}},"documentSupplements":{"items":{"sourceUrl":"url"}}}}
  }$url_schemas$::jsonb ->
    (SELECT adapter_key FROM case_law_sources WHERE id = source) ->
    CASE WHEN composed THEN 'composed' ELSE 'base' END),
  '{}'::jsonb
);
