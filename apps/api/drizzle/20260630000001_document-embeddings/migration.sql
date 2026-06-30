-- stella-migration-safety: reviewed additive-change table-create
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "document_embeddings" (
  "entity_id" uuid NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "chunk_index" integer NOT NULL,
  "embedding" vector(768) NOT NULL,
  "chunk_text" text NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "document_embeddings_pkey" PRIMARY KEY ("entity_id", "chunk_index")
);--> statement-breakpoint
CREATE INDEX "document_embeddings_embedding_idx" ON "document_embeddings" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);--> statement-breakpoint
CREATE INDEX "document_embeddings_entity_id_idx" ON "document_embeddings" ("entity_id");--> statement-breakpoint
ALTER TABLE "document_embeddings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "document_embeddings_org_isolation" ON "document_embeddings"
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM "entities" e
      JOIN "workspaces" w ON w.id = e.workspace_id
      WHERE e.id = document_embeddings.entity_id
        AND w.organization_id = current_setting('app.current_organization_id')::uuid
    )
  );--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "document_embeddings" TO stella;