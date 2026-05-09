ALTER TABLE "organization_settings" ADD COLUMN "disabled_native_tools" jsonb DEFAULT '[]'::jsonb NOT NULL;
