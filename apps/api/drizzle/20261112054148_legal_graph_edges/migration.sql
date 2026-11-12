-- requires: 20261111184500_legal_list_claim_rechecks
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- The matter graph: one typed edge table over the blocks that already exist
-- (claims, list facts, documents and the Spots facts are sourced from). A new,
-- empty table; the online backfill derives the edges of existing rows.
CREATE TABLE "legal_graph_edges" (
  "entity_feature_gate" text DEFAULT 'pending' NOT NULL,
  "entity_feature_workspace_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "entity_feature_organization_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "from_kind" text NOT NULL,
  "from_claim_id" uuid,
  "from_claim_run_id" uuid,
  "from_entity_id" uuid,
  "to_kind" text NOT NULL,
  "to_entity_id" uuid NOT NULL,
  "stance" text,
  "source_id" uuid,
  "provenance_reason" text,
  "producer_kind" text NOT NULL,
  "producer_id" uuid,
  "confidence" text,
  "created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  -- One edge per identity: replaying a producer writes nothing new.
  CONSTRAINT "legal_graph_edges_identity_unq" UNIQUE NULLS NOT DISTINCT ("workspace_id", "kind", "from_claim_id", "from_entity_id", "to_entity_id", "source_id", "producer_kind", "producer_id"),
  CONSTRAINT "legal_graph_edges_from_claim_fk" FOREIGN KEY ("from_claim_id", "from_claim_run_id", "workspace_id") REFERENCES "legal_list_claims"("id", "run_id", "workspace_id") ON DELETE CASCADE,
  CONSTRAINT "legal_graph_edges_from_entity_fk" FOREIGN KEY ("from_entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE CASCADE,
  CONSTRAINT "legal_graph_edges_to_entity_fk" FOREIGN KEY ("to_entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE CASCADE,
  CONSTRAINT "legal_graph_edges_source_fk" FOREIGN KEY ("source_id") REFERENCES "legal_list_item_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "legal_graph_edges_kind_check" CHECK ("kind" IN ('cites', 'sourced-from', 'mentions', 'about')),
  CONSTRAINT "legal_graph_edges_node_kinds_check" CHECK ("from_kind" IN ('fact', 'claim', 'document', 'person', 'issue') AND "to_kind" IN ('fact', 'claim', 'document', 'person', 'issue')),
  CONSTRAINT "legal_graph_edges_endpoints_check" CHECK (("kind", "from_kind", "to_kind") IN (('cites', 'claim', 'fact'), ('sourced-from', 'fact', 'document'), ('mentions', 'fact', 'person'), ('about', 'fact', 'issue'), ('about', 'claim', 'issue'))),
  CONSTRAINT "legal_graph_edges_from_node_check" CHECK (CASE WHEN "from_kind" = 'claim'
        THEN "from_claim_id" IS NOT NULL AND "from_claim_run_id" IS NOT NULL AND "from_entity_id" IS NULL
        ELSE "from_claim_id" IS NULL AND "from_claim_run_id" IS NULL AND "from_entity_id" IS NOT NULL
        END),
  CONSTRAINT "legal_graph_edges_stance_check" CHECK (("kind" IN ('cites')) = ("stance" IS NOT NULL)
        AND ("stance" IS NULL OR "stance" IN ('supports', 'conflicts', 'record'))),
  CONSTRAINT "legal_graph_edges_provenance_check" CHECK (("source_id" IS NULL) <> ("provenance_reason" IS NULL)
        AND ("kind" IN ('sourced-from', 'mentions', 'about')) = ("source_id" IS NOT NULL)
        AND ("kind" IN ('cites')) = ("provenance_reason" IS NOT NULL)
        AND ("provenance_reason" IS NULL OR "provenance_reason" IN ('claim-anchor'))),
  CONSTRAINT "legal_graph_edges_producer_check" CHECK ("producer_kind" IN ('run', 'recheck', 'extraction', 'reviewer', 'import')
        AND ("producer_kind" IN ('run', 'recheck', 'extraction', 'reviewer')) = ("producer_id" IS NOT NULL)),
  CONSTRAINT "legal_graph_edges_confidence_check" CHECK ("confidence" IS NULL OR "confidence" IN ('high', 'medium', 'low'))
);--> statement-breakpoint
-- Built with the empty table, so nothing is scanned.
CREATE INDEX "legal_graph_edges_from_claim_idx" ON "legal_graph_edges" ("workspace_id", "from_claim_id", "from_claim_run_id") WHERE "from_claim_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "legal_graph_edges_from_entity_idx" ON "legal_graph_edges" ("workspace_id", "from_entity_id") WHERE "from_entity_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "legal_graph_edges_to_entity_idx" ON "legal_graph_edges" ("workspace_id", "to_entity_id");--> statement-breakpoint
CREATE INDEX "legal_graph_edges_source_idx" ON "legal_graph_edges" ("source_id") WHERE "source_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "legal_graph_edges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_graph_edges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Edges are written once and go only by cascade: the request role reads and
-- inserts, nothing else.
GRANT SELECT, INSERT ON TABLE "legal_graph_edges" TO stella;--> statement-breakpoint

CREATE POLICY "workspace_select" ON "legal_graph_edges"
  AS PERMISSIVE FOR SELECT TO stella USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
    ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
  END));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "legal_graph_edges"
  AS PERMISSIVE FOR INSERT TO stella WITH CHECK ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
    ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
  END));--> statement-breakpoint
CREATE POLICY "legal_graph_edges_no_update" ON "legal_graph_edges"
  AS RESTRICTIVE FOR UPDATE TO stella USING (false);--> statement-breakpoint
CREATE POLICY "legal_graph_edges_no_delete" ON "legal_graph_edges"
  AS RESTRICTIVE FOR DELETE TO stella USING (false);
