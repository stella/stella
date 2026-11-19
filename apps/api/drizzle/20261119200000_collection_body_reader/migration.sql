SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Deploy the release permitting these columns before promoting this migration.
-- The view authorizes the exact live attachment through its published host;
-- the reader receives no access to the attachment table or its metadata.
CREATE VIEW "case_law_collection_bodies" WITH (security_barrier = true) AS
SELECT host.id AS host_decision_id,
    attachment.source_id AS collection_source_id,
    attachment.source_document_id AS collection_document_id,
    attachment.source_url,
    attachment.observed_at AS retrieved_at,
    CASE WHEN attachment.source_raw_s3_key ~ (
      '^case-law/raw/[0-9a-f-]{36}/documents/' || attachment.host_decision_id::text || '/payloads/[0-9a-f]{64}$'
    ) THEN attachment.source_raw_s3_key END AS detail_raw_s3_key,
    attachment.source_raw_content_type AS detail_raw_content_type
  FROM case_law_held_decision_attachments AS attachment
  JOIN case_law_published_decisions AS host
    ON host.id = attachment.host_decision_id
  JOIN case_law_sources AS host_source ON host_source.id = host.source_id
  JOIN case_law_sources AS collection_source ON collection_source.id = attachment.source_id
  WHERE attachment.host_withdrawn_at IS NULL
    AND collection_source.adapter_key = 'cz-ns-sbirka'
    AND (host_source.descriptor IS NULL OR host_source.descriptor ->> 'allowsRedistribution' = 'true')
    AND (collection_source.descriptor IS NULL OR collection_source.descriptor ->> 'allowsRedistribution' = 'true')
  UNION ALL
  SELECT host.id AS host_decision_id,
    attachment.source_id AS collection_source_id,
    attachment.source_document_id AS collection_document_id,
    attachment.source_url,
    attachment.observed_at AS retrieved_at,
    CASE WHEN attachment.source_raw_s3_key ~ (
      '^case-law/raw/[0-9a-f-]{36}/documents/' || attachment.host_decision_id::text || '/payloads/[0-9a-f]{64}$'
    ) THEN attachment.source_raw_s3_key END AS detail_raw_s3_key,
    attachment.source_raw_content_type AS detail_raw_content_type
  FROM case_law_held_decision_attachments AS attachment
  JOIN case_law_decision_aliases AS alias
    ON alias.retired_decision_id = attachment.host_decision_id
  JOIN case_law_published_decisions AS host
    ON host.id = alias.canonical_decision_id
  JOIN case_law_sources AS host_source ON host_source.id = host.source_id
  JOIN case_law_sources AS collection_source ON collection_source.id = attachment.source_id
  WHERE attachment.host_withdrawn_at IS NULL
    AND collection_source.adapter_key = 'cz-ns-sbirka'
    AND (host_source.descriptor IS NULL OR host_source.descriptor ->> 'allowsRedistribution' = 'true')
    AND (collection_source.descriptor IS NULL OR collection_source.descriptor ->> 'allowsRedistribution' = 'true');--> statement-breakpoint
GRANT SELECT (host_decision_id, collection_source_id, collection_document_id,
  source_url, retrieved_at, detail_raw_s3_key, detail_raw_content_type)
  ON case_law_collection_bodies TO stella_public_law_reader;--> statement-breakpoint
GRANT SELECT (normalized_s3_key)
  ON case_law_published_decisions TO stella_public_law_reader;
