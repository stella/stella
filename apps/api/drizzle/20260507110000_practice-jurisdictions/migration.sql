ALTER TABLE "organization_settings" ADD COLUMN "practice_jurisdictions" jsonb DEFAULT '[]'::jsonb NOT NULL;
