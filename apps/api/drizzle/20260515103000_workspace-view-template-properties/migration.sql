ALTER TABLE "workspace_view_templates"
ADD COLUMN "template_properties" jsonb DEFAULT '[]'::jsonb NOT NULL;
