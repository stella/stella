CREATE INDEX IF NOT EXISTS "fields_pending_workspace_idx" ON "fields" ("workspace_id") WHERE "content"->>'type' = 'pending';
