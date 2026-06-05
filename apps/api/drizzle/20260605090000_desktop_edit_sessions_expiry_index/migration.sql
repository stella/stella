CREATE INDEX "desktop_edit_sessions_open_token_expires_idx" ON "desktop_edit_sessions" ("token_expires_at") WHERE "status" = 'open';
