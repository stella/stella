-- requires: 20261008160000_public_law_read_snapshots
-- requires: 20260803100000_chat_turns
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "chat_messages" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_revision_nonnegative" CHECK ("revision" >= 0) NOT VALID;--> statement-breakpoint

CREATE TABLE "chat_message_revisions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "message_id" uuid NOT NULL,
  "thread_id" uuid NOT NULL REFERENCES "chat_threads"("id") ON DELETE CASCADE,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "revision" integer NOT NULL,
  "content" jsonb NOT NULL,
  "edit" jsonb NOT NULL,
  "created_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chat_message_revisions_message_thread_fk"
    FOREIGN KEY ("message_id", "thread_id") REFERENCES "chat_messages"("id", "thread_id") ON DELETE CASCADE,
  CONSTRAINT "chat_message_revisions_revision_nonnegative" CHECK ("revision" >= 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX "chat_message_revisions_message_revision_uidx" ON "chat_message_revisions" ("message_id", "revision");--> statement-breakpoint
CREATE INDEX "chat_message_revisions_workspace_thread_idx" ON "chat_message_revisions" ("workspace_id", "thread_id");--> statement-breakpoint
CREATE INDEX "chat_message_revisions_thread_idx" ON "chat_message_revisions" ("thread_id");--> statement-breakpoint
CREATE INDEX "chat_message_revisions_created_by_idx" ON "chat_message_revisions" ("created_by");--> statement-breakpoint

ALTER TABLE "chat_message_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_message_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- The parent message applies user, organization, optional matter and embedded
-- matter scope, including global threads. Copied tenant columns must agree.
CREATE POLICY "chat_message_revision_select" ON "chat_message_revisions"
  AS PERMISSIVE FOR SELECT TO "stella" USING (EXISTS (
    SELECT 1 FROM chat_messages cm
    WHERE cm.id = chat_message_revisions.message_id
      AND cm.thread_id = chat_message_revisions.thread_id
      AND cm.workspace_id IS NOT DISTINCT FROM chat_message_revisions.workspace_id
  ));--> statement-breakpoint
CREATE POLICY "chat_message_revision_insert" ON "chat_message_revisions"
  AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (EXISTS (
    SELECT 1 FROM chat_messages cm
    WHERE cm.id = chat_message_revisions.message_id
      AND cm.thread_id = chat_message_revisions.thread_id
      AND cm.workspace_id IS NOT DISTINCT FROM chat_message_revisions.workspace_id
  ));--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE "chat_message_revisions" TO "stella";
