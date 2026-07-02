-- stella-migration-safety: reviewed destructive-change - DROP TABLE "playbooks" runs after its rows are backfilled into the new org-scoped "playbook_definitions" table in this same transaction; no data is lost.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "playbook_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"name" varchar(256) NOT NULL,
	"description" text,
	"scope" jsonb,
	"positions" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_definitions_id_org_unq" UNIQUE("id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "playbook_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "playbook_definitions" ADD CONSTRAINT "playbook_definitions_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
CREATE INDEX "playbook_definitions_organization_id_idx" ON "playbook_definitions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "playbook_definitions_org_created_at_idx" ON "playbook_definitions" USING btree ("organization_id","created_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "playbook_definitions" TO stella;--> statement-breakpoint
CREATE POLICY "organization_select" ON "playbook_definitions" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "playbook_definitions" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "playbook_definitions" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "playbook_definitions" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
INSERT INTO "playbook_definitions" (
	"id",
	"organization_id",
	"name",
	"description",
	"scope",
	"positions",
	"created_at",
	"updated_at"
)
SELECT
	p."id",
	w."organization_id",
	p."name",
	NULL,
	NULL,
	jsonb_build_object(
		'version', 1,
		'items', COALESCE(
			(
				SELECT jsonb_agg(
					jsonb_build_object(
						'sourceId', col->>'sourceId',
						'issue', col->>'name',
						'ask', jsonb_build_object(
							'question', COALESCE(col->>'prompt', ''),
							'content', col->'content'
						),
						'standard', jsonb_build_object('source', 'none'),
						'rule', jsonb_build_object('kind', 'extractOnly'),
						'severity', 'medium'
					)
				)
				FROM jsonb_array_elements(p."bundle") AS col
			),
			'[]'::jsonb
		)
	),
	p."created_at",
	p."updated_at"
FROM "playbooks" p
JOIN "workspaces" w ON w."id" = p."workspace_id";
--> statement-breakpoint
DROP TABLE "playbooks";
