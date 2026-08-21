SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- `stella_caselaw_reader`: the NOLOGIN role that can read the public
-- case-law corpus and nothing else.
--
-- `case-law-public-read-db.ts` refuses any connection whose role can
-- read a table outside PUBLIC_CASE_LAW_RELATIONS, or write anywhere.
-- Until now no migration defined a role that satisfies that check, so
-- each deployment granted tables by hand and the next addition to the
-- allowlist broke it. The grants below are that allowlist, and
-- `case-law-reader-role.test.ts` fails when the two diverge.
--
-- A login user for public corpus reads is granted membership of this
-- role (`GRANT stella_caselaw_reader TO <user>`) and holds no direct
-- table privileges of its own.
CREATE ROLE stella_caselaw_reader NOLOGIN;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO stella_caselaw_reader;--> statement-breakpoint

GRANT SELECT ON TABLE
  "case_law_citations",
  "case_law_corpus_index_projections",
  "case_law_decisions",
  "case_law_provision_citations"
TO stella_caselaw_reader;--> statement-breakpoint

-- case_law_sources is read column by column: the join key, the display
-- fields and the redistribution descriptor. Sync cursors, lease tokens
-- and adapter config are operational and never leave the ingestion side.
GRANT SELECT (id, name, adapter_key, descriptor)
  ON TABLE "case_law_sources"
  TO stella_caselaw_reader;
--> statement-breakpoint

-- Row visibility on the same five tables; a grant alone sees no rows
-- once row security is on.
CREATE POLICY "case_law_reader_access" ON "case_law_citations" AS PERMISSIVE FOR SELECT TO "stella_caselaw_reader" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_reader_access" ON "case_law_corpus_index_projections" AS PERMISSIVE FOR SELECT TO "stella_caselaw_reader" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_reader_access" ON "case_law_decisions" AS PERMISSIVE FOR SELECT TO "stella_caselaw_reader" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_reader_access" ON "case_law_provision_citations" AS PERMISSIVE FOR SELECT TO "stella_caselaw_reader" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_reader_access" ON "case_law_sources" AS PERMISSIVE FOR SELECT TO "stella_caselaw_reader" USING (true);
