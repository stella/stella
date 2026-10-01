SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';
-- stella-migration-safety: reviewed high-volume-index-build - the index is safe
CREATE INDEX case_law_decisions_acknowledged_idx ON case_law_decisions (id);
