ALTER TABLE "workspaces"
ADD COLUMN "lead_user_id" text;

ALTER TABLE "workspaces"
ADD CONSTRAINT "workspaces_lead_user_id_user_id_fk"
FOREIGN KEY ("lead_user_id") REFERENCES "user"("id") ON DELETE SET NULL;
