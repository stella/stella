ALTER TABLE "organization_settings" ADD COLUMN "native_tool_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;

-- Keep disabled_native_tools for rolling deploy and rollback compatibility.
-- A later release can drop it after all live API versions read native_tool_overrides.
UPDATE "organization_settings"
SET "native_tool_overrides" = (
  SELECT coalesce(jsonb_object_agg(value, false), '{}'::jsonb)
  FROM jsonb_array_elements_text("disabled_native_tools") AS value
)
WHERE jsonb_array_length("disabled_native_tools") > 0;
