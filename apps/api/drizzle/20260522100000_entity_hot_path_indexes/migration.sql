CREATE INDEX IF NOT EXISTS "entities_ws_created_at_id_idx" ON "entities" ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_ws_updated_at_id_idx" ON "entities" ("workspace_id","updated_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_ws_kind_created_at_id_idx" ON "entities" ("workspace_id","kind","created_at","id");
