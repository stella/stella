CREATE INDEX "ai_memories_created_by_status_idx" ON "ai_memories" USING btree ("created_by", "status") WHERE "created_by" IS NOT NULL;
