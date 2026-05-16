CREATE INDEX "chat_threads_org_user_updated_id_idx" ON "chat_threads" ("organization_id", "user_id", "updated_at", "id");
