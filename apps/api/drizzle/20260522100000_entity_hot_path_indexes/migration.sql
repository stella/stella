ALTER TABLE "entities" ADD COLUMN "display_name" varchar(512) DEFAULT 'Untitled' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fields_ws_entity_version_property_idx" ON "fields" ("workspace_id","entity_version_id","property_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION stella_entity_display_name(
  entity_name text,
  entity_kind text,
  entity_workspace_id uuid,
  entity_current_version_id uuid
)
RETURNS varchar(512)
LANGUAGE sql
STABLE
AS $$
  SELECT LEFT(
    COALESCE(
      NULLIF(entity_name, ''),
      (
        SELECT NULLIF(f."content"->>'fileName', '')
        FROM "fields" f
        WHERE f."workspace_id" = entity_workspace_id
          AND f."entity_version_id" = entity_current_version_id
          AND f."content"->>'type' = 'file'
        ORDER BY f."property_id" ASC
        LIMIT 1
      ),
      (
        SELECT NULLIF(BTRIM(f."content"->>'value'), '')
        FROM "fields" f
        WHERE f."workspace_id" = entity_workspace_id
          AND f."entity_version_id" = entity_current_version_id
          AND f."content"->>'type' = 'text'
        ORDER BY f."property_id" ASC
        LIMIT 1
      ),
      CASE
        WHEN entity_kind = 'folder' THEN 'Untitled Folder'
        WHEN entity_kind = 'task' THEN 'Untitled Task'
        ELSE 'Untitled'
      END
    ),
    512
  )::varchar(512)
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION stella_refresh_entity_display_name(entity_id uuid)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE "entities" e
  SET "display_name" = stella_entity_display_name(
    e."name",
    e."kind",
    e."workspace_id",
    e."current_version_id"
  )
  WHERE e."id" = entity_id
$$;--> statement-breakpoint
UPDATE "entities" e
SET "display_name" = stella_entity_display_name(
  e."name",
  e."kind",
  e."workspace_id",
  e."current_version_id"
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION stella_refresh_entity_display_name_from_entity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM stella_refresh_entity_display_name(NEW."id");
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION stella_refresh_entity_display_name_from_field()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    PERFORM stella_refresh_entity_display_name(e."id")
    FROM "entities" e
    WHERE e."workspace_id" = NEW."workspace_id"
      AND e."current_version_id" = NEW."entity_version_id";
  END IF;

  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    PERFORM stella_refresh_entity_display_name(e."id")
    FROM "entities" e
    WHERE e."workspace_id" = OLD."workspace_id"
      AND e."current_version_id" = OLD."entity_version_id";
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER entities_refresh_display_name_after_write
AFTER INSERT OR UPDATE OF "name", "kind", "current_version_id", "workspace_id"
ON "entities"
FOR EACH ROW
EXECUTE FUNCTION stella_refresh_entity_display_name_from_entity();--> statement-breakpoint
CREATE TRIGGER fields_refresh_entity_display_name_after_write
AFTER INSERT OR UPDATE OF "content", "property_id", "entity_version_id", "workspace_id" OR DELETE
ON "fields"
FOR EACH ROW
EXECUTE FUNCTION stella_refresh_entity_display_name_from_field();--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_ws_created_at_id_idx" ON "entities" ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_ws_updated_at_id_idx" ON "entities" ("workspace_id","updated_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_ws_updated_at_coalesce_id_idx" ON "entities" ("workspace_id",(COALESCE("updated_at", '0001-01-01 00:00:00'::timestamp)),"id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_ws_display_name_id_idx" ON "entities" ("workspace_id","display_name","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_ws_kind_created_at_id_idx" ON "entities" ("workspace_id","kind","created_at","id");
