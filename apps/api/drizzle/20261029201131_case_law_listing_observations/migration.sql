-- requires: 20260811110000_case_law_reconciliation_items
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "case_law_listing_observations" (
  "source_id" uuid NOT NULL CONSTRAINT "case_law_listing_observations_source_id_case_law_sources_id_fk" REFERENCES "case_law_sources"("id") ON DELETE CASCADE,
  "fingerprint" varchar(64) NOT NULL,
  "adapter_key" varchar(32) NOT NULL,
  "reason" varchar(32) NOT NULL,
  "payload" jsonb NOT NULL,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "case_law_listing_observations_pkey" PRIMARY KEY ("source_id", "fingerprint"),
  CONSTRAINT "case_law_listing_observations_fingerprint" CHECK ("fingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "case_law_listing_observations_reason" CHECK ("reason" IN ('no-usable-id', 'unserved-listing-record'))
);--> statement-breakpoint
ALTER TABLE "case_law_listing_observations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_listing_observations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_listing_observations_read" ON "case_law_listing_observations" FOR SELECT TO stella, stella_ingestion USING (true);--> statement-breakpoint
CREATE POLICY "case_law_listing_observations_insert" ON "case_law_listing_observations" FOR INSERT TO stella_ingestion WITH CHECK (true);--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_listing_observations" TO stella, stella_ingestion;--> statement-breakpoint
GRANT INSERT ON TABLE "case_law_listing_observations" TO stella_ingestion;
