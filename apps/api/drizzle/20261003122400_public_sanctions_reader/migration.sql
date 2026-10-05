-- requires: 20261003121900_sanctions_sources
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE ROLE stella_public_sanctions_reader NOLOGIN;--> statement-breakpoint
-- The application connection must be able to assume the read-only role.
DO $$
BEGIN
  IF CURRENT_USER <> 'stella_public_sanctions_reader'
     AND NOT pg_has_role(CURRENT_USER, 'stella_public_sanctions_reader', 'SET') THEN
    EXECUTE format('GRANT stella_public_sanctions_reader TO %I WITH SET TRUE, INHERIT FALSE', CURRENT_USER);
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO stella_public_sanctions_reader;--> statement-breakpoint

-- Freshness decisions are identical to signed-in screening; transport endpoints
-- and configuration stay inaccessible to the anonymous reader.
GRANT SELECT (
  id, issuer, licence, active_edition_id, held_edition_id, held_guard_code,
  held_at, held_previous_count, held_next_count, last_checked_at,
  last_successful_verified_at, last_failure_at, last_failure_code
) ON TABLE sanctions_sources TO stella_public_sanctions_reader;--> statement-breakpoint
GRANT SELECT (id, state, published_at, file_id, entry_count)
  ON TABLE sanctions_editions TO stella_public_sanctions_reader;--> statement-breakpoint
GRANT SELECT (content_hash, payload)
  ON TABLE sanctions_entry_payloads TO stella_public_sanctions_reader;--> statement-breakpoint
GRANT SELECT (edition_id, source_entry_id, content_hash)
  ON TABLE sanctions_edition_entries TO stella_public_sanctions_reader;--> statement-breakpoint

CREATE POLICY public_sanctions_reader_access ON sanctions_sources
  FOR SELECT TO stella_public_sanctions_reader USING (true);--> statement-breakpoint
CREATE POLICY public_sanctions_reader_access ON sanctions_editions
  FOR SELECT TO stella_public_sanctions_reader USING (true);--> statement-breakpoint
CREATE POLICY public_sanctions_reader_access ON sanctions_entry_payloads
  FOR SELECT TO stella_public_sanctions_reader USING (true);--> statement-breakpoint
CREATE POLICY public_sanctions_reader_access ON sanctions_edition_entries
  FOR SELECT TO stella_public_sanctions_reader USING (true);--> statement-breakpoint
