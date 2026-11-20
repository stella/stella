SET lock_timeout = '1s';
SET statement_timeout = '30s';

ALTER TABLE case_law_ingestion_events ADD COLUMN pause_reason varchar(64);
ALTER TABLE case_law_ingestion_events
  ADD CONSTRAINT case_law_ingestion_events_status_valid
  CHECK (status IN ('completed', 'paused', 'failed', 'timeout')) NOT VALID,
  ADD CONSTRAINT case_law_ingestion_events_pause_reason_valid
  CHECK (
    (status = 'paused' AND pause_reason IS NOT NULL AND pause_reason = 'decision_allowance_exhausted')
    OR (status <> 'paused' AND pause_reason IS NULL)
  ) NOT VALID;
