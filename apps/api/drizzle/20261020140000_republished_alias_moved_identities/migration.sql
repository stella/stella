-- requires: 20261020130000_cross_source_decision_aliases
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "case_law_decision_alias_moved_identities" (
	"retired_decision_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"source_document_id" varchar(1024) NOT NULL,
	CONSTRAINT "case_law_decision_alias_moved_identities_pk" PRIMARY KEY("retired_decision_id","source_id","source_document_id"),
	CONSTRAINT "case_law_decision_alias_moved_identities_alias_fk" FOREIGN KEY ("retired_decision_id") REFERENCES "public"."case_law_decision_aliases"("retired_decision_id") ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE "case_law_decision_alias_moved_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_decision_alias_moved_identities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_decision_alias_moved_identities"
  FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL ON TABLE "case_law_decision_alias_moved_identities" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_decision_alias_moved_identities" FROM stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_decision_alias_moved_identities" TO stella_ingestion;--> statement-breakpoint
