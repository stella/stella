-- requires: 20261101090000_organization_audit_exports
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- An organization row is deleted only by the organization deletion owner
-- (completeOrganizationDeletion), which first requires the audit archive the
-- cascade would otherwise remove. The owner names the row it deletes in a
-- transaction-local setting; any other delete of an organization row fails.
-- SECURITY INVOKER with a fixed search path: it reads only the caller's own
-- setting and the deleted row.
CREATE FUNCTION public.organization_delete_requires_owner() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT (
    OLD.id = ANY (
      pg_catalog.string_to_array(
        COALESCE(pg_catalog.current_setting('app.organization_deletion_ids', true), ''),
        ','
      )
    )
  ) THEN
    RAISE EXCEPTION 'An organization is deleted only through organization deletion'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER organization_delete_requires_owner
BEFORE DELETE ON "organization"
FOR EACH ROW
EXECUTE FUNCTION public.organization_delete_requires_owner();
