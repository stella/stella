SET lock_timeout = '1s';
SET statement_timeout = '30s';

ALTER TABLE legislation_amendments
  ADD COLUMN effect_details jsonb,
  ADD COLUMN observations jsonb;
ALTER TABLE legislation_amendment_snapshots
  ADD COLUMN channel_snapshots jsonb;

GRANT SELECT (effect_details, observations)
  ON legislation_amendments TO stella_public_law_reader;

ALTER TABLE legislation_amendments
  ADD CONSTRAINT legislation_amendments_effect_projection
  CHECK (effect_details IS NULL OR COALESCE(CASE effect_details->>'type'
    WHEN 'date' THEN effective_date IS NOT NULL AND effective_date::text = effect_details->>'on'
    WHEN 'conditional' THEN effective_date::text IS NOT DISTINCT FROM effect_details->>'actualDate'
    WHEN 'not-stated' THEN effective_date IS NULL
    WHEN 'conflicting' THEN effective_date IS NULL
    ELSE false END, false)) NOT VALID;
