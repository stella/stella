SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Promote only after the releases permitting these columns, the snapshot
-- projection and the recorded observation timestamp run in every public reader.
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
    attachment.source_raw_content_type AS detail_raw_content_type,
    attachment.document_part - 'legalSentence' AS document_part,
    CASE WHEN attachment.document_body_s3_key ~ (
      '^case-law/raw/[0-9a-f-]{36}/documents/' || attachment.host_decision_id::text || '/payloads/[0-9a-f]{64}$'
    ) AND right(attachment.document_body_s3_key, 64) = attachment.document_body_sha256
      AND attachment.match_evidence->>'status' = 'matched'
      THEN attachment.document_body_s3_key END AS document_body_s3_key,
    attachment.document_body_sha256,
    CASE WHEN attachment.source_id = host.source_id
      AND attachment.source_document_id = host.source_document_id
      THEN 'canonical-own-row' ELSE 'attachment' END::varchar AS origin
  FROM case_law_held_decision_attachments AS attachment
  JOIN case_law_decisions AS host
    ON host.id = attachment.host_decision_id
  JOIN case_law_sources AS host_source ON host_source.id = host.source_id
  JOIN case_law_sources AS collection_source ON collection_source.id = attachment.source_id
  WHERE attachment.host_withdrawn_at IS NULL
    AND (host.redacted_at IS NULL AND jsonb_extract_path_text(host.metadata, '_stellaPartialObservation', 'isListingOnly') IS DISTINCT FROM 'true')
    AND ((collection_source.adapter_key = 'cz-ns-sbirka'
        AND (attachment.match_evidence IS NULL OR attachment.match_evidence->>'status' = 'matched'))
      OR (attachment.document_part IS NOT NULL AND attachment.match_evidence->>'status' = 'matched'))
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
    attachment.source_raw_content_type AS detail_raw_content_type,
    attachment.document_part - 'legalSentence' AS document_part,
    CASE WHEN attachment.document_body_s3_key ~ (
      '^case-law/raw/[0-9a-f-]{36}/documents/' || attachment.host_decision_id::text || '/payloads/[0-9a-f]{64}$'
    ) AND right(attachment.document_body_s3_key, 64) = attachment.document_body_sha256
      AND attachment.match_evidence->>'status' = 'matched'
      THEN attachment.document_body_s3_key END AS document_body_s3_key,
    attachment.document_body_sha256,
    'attachment'::varchar AS origin
  FROM case_law_held_decision_attachments AS attachment
  JOIN case_law_decision_aliases AS alias
    ON alias.retired_decision_id = attachment.host_decision_id
  JOIN case_law_decisions AS host
    ON host.id = alias.canonical_decision_id
  JOIN case_law_sources AS host_source ON host_source.id = host.source_id
  JOIN case_law_sources AS collection_source ON collection_source.id = attachment.source_id
  WHERE attachment.host_withdrawn_at IS NULL
    AND (host.redacted_at IS NULL AND jsonb_extract_path_text(host.metadata, '_stellaPartialObservation', 'isListingOnly') IS DISTINCT FROM 'true')
    AND ((collection_source.adapter_key = 'cz-ns-sbirka'
        AND (attachment.match_evidence IS NULL OR attachment.match_evidence->>'status' = 'matched'))
      OR (attachment.document_part IS NOT NULL AND attachment.match_evidence->>'status' = 'matched'))
    AND (host_source.descriptor IS NULL OR host_source.descriptor ->> 'allowsRedistribution' = 'true')
    AND (collection_source.descriptor IS NULL OR collection_source.descriptor ->> 'allowsRedistribution' = 'true');--> statement-breakpoint
GRANT SELECT (host_decision_id, collection_source_id, collection_document_id,
  source_url, retrieved_at, detail_raw_s3_key, detail_raw_content_type,
  document_part, document_body_s3_key, document_body_sha256, origin)
  ON case_law_collection_bodies TO stella_public_law_reader;--> statement-breakpoint
GRANT SELECT (normalized_s3_key, source_observed_at)
  ON case_law_published_decisions TO stella_public_law_reader;
