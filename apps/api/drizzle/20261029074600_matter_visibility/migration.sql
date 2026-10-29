-- requires: 20261015090000_matter_access_rule_function
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Matter visibility is its own column instead of being implied by the client.
--
-- Until now a NULL client_id meant "personal": visible only to the matter's
-- members, never to organization owners and admins. `visibility` carries that
-- decision explicitly, in three levels, widest first:
--   all_members          every internal member (owner, admin, member, intern)
--   admins_and_assigned  owners and admins, plus assigned members (the old
--                        client-matter rule)
--   assigned_only        assigned members only (the old personal rule)
-- So a matter can have no client and still be open to the organization
-- (internal templates, know-how, internal administration), and a matter with
-- a client can be closed to everyone not assigned. External members never
-- reach a matter without an assignment.
--
-- Existing rows start conservatively assigned-only; the bounded repair restores
-- client matters to their previous admin reach before authorization cutover.
-- Adding the column with a constant default is a metadata-only change; the
-- CHECK is validated by the online phase after its bounded backfill.
ALTER TABLE "workspaces"
  ADD COLUMN "visibility" text DEFAULT 'assigned_only' NOT NULL,
  ADD CONSTRAINT "workspaces_visibility_check"
    CHECK ("visibility" IN ('all_members', 'admins_and_assigned', 'assigned_only')) NOT VALID;
--> statement-breakpoint

-- Existing rows retain the old access rule until the bounded online repair
-- finishes. Its cursor and atomic function/view cutover are owned by
-- src/db/matter-visibility-repair.ts. NOT VALID avoids a deploy-time scan.

CREATE FUNCTION public.workspaces_legacy_visibility() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The creating user leads a clientless matter they made without a lead
  -- (the old writer assigns its creator), keeping the steward invariant.
  -- A missing or unusable creator is refused by deferred steward validation.
  IF NEW.client_id IS NULL THEN
    NEW.lead_user_id := COALESCE(
      NEW.lead_user_id,
      NULLIF(pg_catalog.current_setting('app.user_id', true), '')
    );
  END IF;
  NEW.visibility := CASE
    WHEN NEW.client_id IS NULL THEN 'assigned_only'
    ELSE 'admins_and_assigned'
  END;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER workspaces_legacy_visibility
BEFORE INSERT ON "workspaces"
FOR EACH ROW
WHEN (NEW.visibility IS NULL)
EXECUTE FUNCTION public.workspaces_legacy_visibility();
--> statement-breakpoint

-- No database default: the application always states a visibility. A writer
-- that predates this column (an API instance still rolling out) omits it, and
-- the preceding trigger gives that row the visibility the old rule implied, so a
-- clientless matter created mid-rollout stays assigned_only rather than
-- defaulting to admins_and_assigned. CONTRACT STEP: drop the trigger and the
-- function in a later release, once no such writer can remain.
-- squawk-ignore ban-drop-default -- The preceding insert trigger supplies the legacy visibility for rolling old writers; new writers state it explicitly.
ALTER TABLE "workspaces" ALTER COLUMN "visibility" DROP DEFAULT;
--> statement-breakpoint

-- Root-owned transaction proofs make the lock protocol enforceable without
-- trusting mutable application settings. Completed older proofs are pruned in
-- bounded batches; active transactions are never touched.
CREATE TABLE public.matter_stewardship_locks (
  transaction_id bigint PRIMARY KEY,
  proof jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE public.matter_stewardship_locks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY matter_stewardship_lock_owner_access ON public.matter_stewardship_locks
FOR ALL TO public
USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.matter_stewardship_locks'::regclass))
WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.matter_stewardship_locks'::regclass));
--> statement-breakpoint
REVOKE ALL ON TABLE public.matter_stewardship_locks FROM PUBLIC, stella;
--> statement-breakpoint

-- Every stewardship writer and reach hold uses this prefix, including native
-- online-repair connections. Discovery is repeated after candidate membership
-- locks: a newly committed relationship requires a fresh transaction, never a
-- late lifecycle/member acquisition below a matter lock.
-- stella-migration-safety: reviewed security-definer - fixed search path; tenant-qualified discovery acquires the canonical prefix and writes only root-owned transaction proofs; scoped sessions cannot discover membership-wide matter IDs or cross tenants
CREATE FUNCTION public.stella_lock_matter_stewardship(p_requests jsonb, p_mode text)
RETURNS TABLE (workspace_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  targets uuid[];
  candidates text[];
  fresh_targets uuid[];
  fresh_candidates text[];
  locked_candidates text[];
  held jsonb;
BEGIN
  IF p_mode NOT IN ('share', 'update') OR jsonb_typeof(p_requests) <> 'array' THEN
    RAISE EXCEPTION 'invalid stewardship lock request' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Root repair/account operations may span organizations. A restricted
  -- application session may lock only its transaction's authenticated tenant.
  IF current_setting('role', true) = 'stella' AND (
    NULLIF(current_setting('app.organization_id', true), '') IS NULL OR EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_requests) AS r(organization_id text)
      WHERE r.organization_id IS DISTINCT FROM NULLIF(current_setting('app.organization_id', true), '')
    )
  ) THEN
    RAISE EXCEPTION 'stewardship lock requires the transaction organization' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_setting('role', true) = 'stella' AND EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_requests) AS r(membership_user_ids text[])
    WHERE cardinality(r.membership_user_ids) > 0
  ) THEN
    RAISE EXCEPTION 'membership-wide stewardship discovery requires the database owner' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT proof INTO held FROM public.matter_stewardship_locks
    WHERE transaction_id = txid_current();
  -- Explicit IDs also reserve future creation identities. Echo them uniformly:
  -- foreign and absent IDs must not differ in discovery or error behavior.
  -- Matter rows and candidate memberships are discovered and locked only within the request tenant.
  SELECT COALESCE(array_agg(DISTINCT w.id ORDER BY w.id), '{}'::uuid[]) INTO targets
  FROM jsonb_to_recordset(p_requests) AS r(organization_id text, workspace_ids uuid[], membership_user_ids text[])
  CROSS JOIN LATERAL (
    SELECT requested.id FROM unnest(r.workspace_ids) AS requested(id)
    UNION
    SELECT matter.id FROM public.workspaces matter
    WHERE matter.organization_id = r.organization_id AND (
      matter.lead_user_id = ANY(r.membership_user_ids) OR EXISTS (
        SELECT 1 FROM public.workspace_members a WHERE a.workspace_id = matter.id
          AND a.user_id = ANY(r.membership_user_ids)
      )
    )
  ) w;
  SELECT COALESCE(array_agg(DISTINCT m.id ORDER BY m.id), '{}'::text[]) INTO candidates
  FROM public.member m
  JOIN jsonb_to_recordset(p_requests) AS r(organization_id text, workspace_ids uuid[], user_ids text[], membership_user_ids text[])
    ON r.organization_id = m.organization_id
  WHERE m.user_id = ANY(COALESCE(r.user_ids, '{}') || COALESCE(r.membership_user_ids, '{}'))
    OR EXISTS (
      SELECT 1 FROM public.workspaces w WHERE w.organization_id = r.organization_id
        AND w.id = ANY(targets) AND (w.lead_user_id = m.user_id OR EXISTS (
          SELECT 1 FROM public.workspace_members a WHERE a.workspace_id = w.id AND a.user_id = m.user_id
        ))
    );
  IF held IS NOT NULL THEN
    IF (p_mode = 'update' AND held->>'mode' <> 'update')
      OR NOT (held->'workspaces' @> to_jsonb(targets))
      OR NOT (held->'members' @> to_jsonb(candidates)) THEN
      RAISE EXCEPTION 'stewardship lock scope changed; retry the transaction' USING ERRCODE = 'lock_not_available';
    END IF;
    RETURN QUERY SELECT unnest(targets);
    RETURN;
  END IF;
  DELETE FROM public.matter_stewardship_locks WHERE transaction_id IN (
    SELECT transaction_id FROM public.matter_stewardship_locks
    WHERE transaction_id < txid_snapshot_xmin(txid_current_snapshot())
    ORDER BY transaction_id LIMIT 64 FOR UPDATE SKIP LOCKED
  );
  PERFORM pg_advisory_xact_lock(hashtext(target.id::text))
  FROM unnest(targets) AS target(id)
  ORDER BY target.id;
  IF p_mode = 'update' THEN
    SELECT COALESCE(array_agg(locked.id ORDER BY locked.id), '{}'::text[]) INTO locked_candidates
    FROM (SELECT m.id FROM public.member m WHERE m.id = ANY(candidates) ORDER BY m.id FOR NO KEY UPDATE) locked;
  ELSE
    SELECT COALESCE(array_agg(locked.id ORDER BY locked.id), '{}'::text[]) INTO locked_candidates
    FROM (SELECT m.id FROM public.member m WHERE m.id = ANY(candidates) ORDER BY m.id FOR SHARE) locked;
  END IF;
  SELECT COALESCE(array_agg(DISTINCT w.id ORDER BY w.id), '{}'::uuid[]) INTO fresh_targets
  FROM jsonb_to_recordset(p_requests) AS r(organization_id text, workspace_ids uuid[], membership_user_ids text[])
  CROSS JOIN LATERAL (
    SELECT requested.id FROM unnest(r.workspace_ids) AS requested(id)
    UNION
    SELECT matter.id FROM public.workspaces matter
    WHERE matter.organization_id = r.organization_id AND (
      matter.lead_user_id = ANY(r.membership_user_ids) OR EXISTS (
        SELECT 1 FROM public.workspace_members a WHERE a.workspace_id = matter.id
          AND a.user_id = ANY(r.membership_user_ids)
      )
    )
  ) w;
  SELECT COALESCE(array_agg(DISTINCT m.id ORDER BY m.id), '{}'::text[]) INTO fresh_candidates
  FROM public.member m
  JOIN jsonb_to_recordset(p_requests) AS r(organization_id text, workspace_ids uuid[], user_ids text[], membership_user_ids text[])
    ON r.organization_id = m.organization_id
  WHERE m.user_id = ANY(COALESCE(r.user_ids, '{}') || COALESCE(r.membership_user_ids, '{}'))
    OR EXISTS (
      SELECT 1 FROM public.workspaces w WHERE w.organization_id = r.organization_id
        AND w.id = ANY(targets) AND (w.lead_user_id = m.user_id OR EXISTS (
          SELECT 1 FROM public.workspace_members a WHERE a.workspace_id = w.id AND a.user_id = m.user_id
        ))
    );
  IF fresh_targets <> targets OR fresh_candidates <> candidates OR locked_candidates <> candidates THEN
    RAISE EXCEPTION 'stewardship relationships changed; retry the transaction' USING ERRCODE = 'lock_not_available';
  END IF;
  IF p_mode = 'update' THEN
    PERFORM w.id FROM public.workspaces w
      JOIN jsonb_to_recordset(p_requests) AS r(organization_id text) ON r.organization_id = w.organization_id
      WHERE w.id = ANY(targets) ORDER BY w.id FOR UPDATE OF w;
  ELSE
    PERFORM w.id FROM public.workspaces w
      JOIN jsonb_to_recordset(p_requests) AS r(organization_id text) ON r.organization_id = w.organization_id
      WHERE w.id = ANY(targets) ORDER BY w.id FOR SHARE OF w;
  END IF;
  INSERT INTO public.matter_stewardship_locks(transaction_id, proof)
  VALUES (txid_current(), jsonb_build_object(
    'mode', p_mode, 'workspaces', targets, 'members', candidates
  ));
  RETURN QUERY SELECT unnest(targets);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_lock_matter_stewardship(jsonb, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_lock_matter_stewardship(jsonb, text) TO stella;
--> statement-breakpoint

-- No row or advisory locks are acquired by validation triggers. Unsupported
-- writers fail closed instead of waiting in an inverted order.
CREATE FUNCTION public.stella_has_stewardship_lock(p_kind text, p_id text)
RETURNS boolean LANGUAGE sql
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE((SELECT proof->>'mode' = 'update'
    AND proof->p_kind @> jsonb_build_array(p_id)
    FROM public.matter_stewardship_locks WHERE transaction_id = txid_current()), false);
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_has_stewardship_lock(text, text) FROM PUBLIC;
--> statement-breakpoint

-- Safe removals remain compatible with API instances from before this migration.
-- Only losing a usable assigned-only steward requires the prefix and is refused.
-- stella-migration-safety: reviewed security-definer - fixed search path and PUBLIC execute revoked; reads only the persisted member's organization and assignments, requires the completed lock prefix only for usable-steward loss, refuses that loss, and writes nothing
CREATE FUNCTION "enforce_member_role_keeps_matter_leads"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id = OLD.organization_id
      AND NEW.user_id = OLD.user_id
      AND NEW.role IN ('owner', 'admin', 'member', 'intern') THEN
      RETURN NEW;
    END IF;
  ELSE
    -- Deleting the organization removes its matters too. Its parent row is
    -- already gone when cascading membership deletes run.
    IF NOT EXISTS (SELECT 1 FROM public.organization WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
  END IF;

  IF OLD.role IN ('owner', 'admin', 'member', 'intern') AND EXISTS (
    SELECT 1 FROM public.workspaces AS w
    WHERE w.organization_id = OLD.organization_id
      AND w.visibility = 'assigned_only'
      AND w.lead_user_id = OLD.user_id
      AND EXISTS (
        SELECT 1 FROM public.workspace_members AS wm
        WHERE wm.workspace_id = w.id AND wm.user_id = OLD.user_id
      )
  ) THEN
    IF NOT public.stella_has_stewardship_lock('members', OLD.id) THEN
      RAISE EXCEPTION 'membership change requires the stewardship lock prefix' USING ERRCODE = 'lock_not_available';
    END IF;
    RAISE EXCEPTION 'member leads a matter visible to assigned members only'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'member_role_keeps_matter_leads';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "enforce_member_role_keeps_matter_leads"() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "member_role_keeps_matter_leads"
BEFORE UPDATE OF "role" ON "member"
FOR EACH ROW
WHEN (NEW.role NOT IN ('owner', 'admin', 'member', 'intern'))
EXECUTE FUNCTION "enforce_member_role_keeps_matter_leads"();
--> statement-breakpoint

CREATE TRIGGER "member_identity_keeps_matter_leads"
BEFORE DELETE OR UPDATE OF "organization_id", "user_id" ON "member"
FOR EACH ROW
EXECUTE FUNCTION "enforce_member_role_keeps_matter_leads"();
--> statement-breakpoint

-- Callers hold candidate memberships before matter rows. These triggers only
-- validate that completed prefix and the resulting steward state.
-- A usable steward is internal, belongs to this organization, and is assigned.
-- stella-migration-safety: reviewed security-definer - fixed search path and PUBLIC execute revoked; validates the updated matter under its existing row lock and appends a matter-scoped audit for legacy unusable-lead cleanup
CREATE FUNCTION public.enforce_workspace_keeps_matter_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  audit_actor text;
BEGIN
  -- Old offboarding clears a departing lead before removing memberships.
  -- Clearing an already unusable legacy lead preserves its existing orphaned
  -- state and access policy; it must not require the new caller protocol.
  IF OLD.visibility = 'assigned_only' AND NEW.visibility = OLD.visibility
    AND NEW.organization_id = OLD.organization_id AND NEW.lead_user_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.member AS m
      JOIN public.workspace_members AS wm ON wm.user_id = m.user_id
      WHERE m.organization_id = OLD.organization_id AND m.user_id = OLD.lead_user_id
        AND m.role IN ('owner', 'admin', 'member', 'intern')
        AND wm.workspace_id = OLD.id
    ) THEN
    IF OLD.lead_user_id IS NOT NULL
      AND NOT public.stella_has_stewardship_lock('workspaces', OLD.id::text) THEN
      -- New callers use their bound audit recorder. Older callers cannot run
      -- that recorder here, so append the same workspace event transactionally.
      audit_actor := NULLIF(current_setting('app.user_id', true), '');
      INSERT INTO public.audit_logs (
        id, organization_id, workspace_id, user_id, action, resource_type,
        resource_id, metadata, changes, performer_type, performer_id,
        performer_name, trigger_type, trigger_source, group_id, approval_status,
        activity_category
      ) VALUES (
        pg_catalog.gen_random_uuid(), OLD.organization_id, OLD.id,
        COALESCE(audit_actor, 'system:matter-steward-compatibility'),
        'update', 'workspace', OLD.id::text,
        jsonb_build_object('cause', 'matter_steward_cleared'),
        jsonb_build_object('leadUserId', jsonb_build_object('old', OLD.lead_user_id, 'new', NULL)),
        CASE WHEN audit_actor IS NULL THEN 'service' ELSE 'user' END,
        COALESCE(audit_actor, 'system:matter-steward-compatibility'),
        CASE WHEN audit_actor IS NULL THEN 'Matter stewardship compatibility' ELSE NULL END,
        CASE WHEN audit_actor IS NULL THEN 'system' ELSE 'direct' END,
        CASE WHEN audit_actor IS NULL THEN 'matter-steward-compatibility' ELSE NULL END,
        pg_catalog.gen_random_uuid(), 'not_required', 'matter'
      );
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.visibility = 'assigned_only' AND NOT public.stella_has_stewardship_lock('workspaces', NEW.id::text) THEN
    RAISE EXCEPTION 'matter change requires the stewardship lock prefix' USING ERRCODE = 'lock_not_available';
  END IF;
  IF NEW.visibility = 'assigned_only' AND EXISTS (
    SELECT 1 FROM public.member m WHERE m.organization_id = NEW.organization_id
      AND m.user_id = NEW.lead_user_id AND NOT public.stella_has_stewardship_lock('members', m.id)
  ) THEN
    RAISE EXCEPTION 'steward membership requires the stewardship lock prefix' USING ERRCODE = 'lock_not_available';
  END IF;
  IF NEW.visibility = 'assigned_only' AND NOT EXISTS (
    SELECT 1 FROM public.member AS m
    JOIN public.workspace_members AS wm ON wm.user_id = m.user_id
    WHERE m.organization_id = NEW.organization_id
      AND m.user_id = NEW.lead_user_id
      AND m.role IN ('owner', 'admin', 'member', 'intern')
      AND wm.workspace_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'assigned-only matter requires an assigned internal steward'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'workspace_keeps_matter_lead';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.enforce_workspace_keeps_matter_lead() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "workspace_keeps_matter_lead"
BEFORE UPDATE OF "lead_user_id", "visibility", "organization_id" ON "workspaces"
FOR EACH ROW
EXECUTE FUNCTION public.enforce_workspace_keeps_matter_lead();
--> statement-breakpoint

-- INSERT validation waits until assignments in the creation transaction exist.
-- stella-migration-safety: reviewed security-definer - fixed search path and PUBLIC execute revoked; reads the inserted matter, verifies the completed lock prefix and checks stewardship without acquiring locks
CREATE FUNCTION public.enforce_inserted_workspace_keeps_matter_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  matter public.workspaces%ROWTYPE;
BEGIN
  SELECT * INTO matter FROM public.workspaces WHERE id = NEW.id;
  IF NOT FOUND OR matter.visibility <> 'assigned_only' THEN
    RETURN NULL;
  END IF;
  IF NOT public.stella_has_stewardship_lock('workspaces', matter.id::text) THEN
    RAISE EXCEPTION 'matter creation requires the stewardship lock prefix' USING ERRCODE = 'lock_not_available';
  END IF;
  IF EXISTS (SELECT 1 FROM public.member m WHERE m.organization_id = matter.organization_id
    AND m.user_id = matter.lead_user_id AND NOT public.stella_has_stewardship_lock('members', m.id)) THEN
    RAISE EXCEPTION 'steward membership requires the stewardship lock prefix' USING ERRCODE = 'lock_not_available';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.member AS m
    JOIN public.workspace_members AS wm ON wm.user_id = m.user_id
    WHERE m.organization_id = matter.organization_id
      AND m.user_id = matter.lead_user_id
      AND m.role IN ('owner', 'admin', 'member', 'intern')
      AND wm.workspace_id = matter.id
  ) THEN
    RAISE EXCEPTION 'assigned-only matter requires an assigned internal steward'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workspace_keeps_matter_lead';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.enforce_inserted_workspace_keeps_matter_lead() FROM PUBLIC;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER inserted_workspace_keeps_matter_lead
AFTER INSERT ON public.workspaces
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_inserted_workspace_keeps_matter_lead();
--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - fixed search path and PUBLIC execute revoked; reads only the old assignment's persisted steward rows, requires the completed lock prefix only for usable-steward loss, refuses that loss, and writes nothing
CREATE FUNCTION public.enforce_assignment_keeps_matter_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.workspace_id = OLD.workspace_id AND NEW.user_id = OLD.user_id THEN
      RETURN NEW;
    END IF;
  END IF;

  -- An absent parent means the whole matter or organization is being deleted.
  IF EXISTS (
    SELECT 1 FROM public.workspaces AS w
    JOIN public.organization AS o ON o.id = w.organization_id
    WHERE w.id = OLD.workspace_id AND w.visibility = 'assigned_only'
      AND w.lead_user_id = OLD.user_id
      AND EXISTS (
        SELECT 1 FROM public.member AS m
        WHERE m.organization_id = w.organization_id AND m.user_id = OLD.user_id
          AND m.role IN ('owner', 'admin', 'member', 'intern')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.member AS m
        JOIN public.workspace_members AS wm ON wm.user_id = m.user_id
        WHERE m.organization_id = w.organization_id
          AND m.user_id = w.lead_user_id
          AND m.role IN ('owner', 'admin', 'member', 'intern')
          AND wm.workspace_id = w.id
          AND wm.id <> OLD.id
      )
  ) THEN
    IF NOT public.stella_has_stewardship_lock('workspaces', OLD.workspace_id::text) THEN
      RAISE EXCEPTION 'assignment removal requires the stewardship lock prefix' USING ERRCODE = 'lock_not_available';
    END IF;
    RAISE EXCEPTION 'assignment removal would leave an assigned-only matter without a steward'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'assignment_keeps_matter_lead';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.enforce_assignment_keeps_matter_lead() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "assignment_keeps_matter_lead"
BEFORE DELETE OR UPDATE OF "workspace_id", "user_id" ON "workspace_members"
FOR EACH ROW
EXECUTE FUNCTION public.enforce_assignment_keeps_matter_lead();
--> statement-breakpoint

-- Creating a matter: inserts the matter in the transaction's organization and,
-- when the creating member would not reach it otherwise, that member's
-- assignment, so the new matter is reachable through the rule above without
-- naming it in app.workspace_ids. It adds no other member.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; organization and user come from the transaction settings, never from arguments; inserts one matter and at most the caller's own assignment
CREATE FUNCTION public.stella_create_workspace(
  p_workspace_id uuid,
  p_client_id uuid,
  p_name text,
  p_reference text,
  p_billing_reference text,
  p_color text,
  p_lead_user_id text,
  p_visibility text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_organization_id text := NULLIF(
    pg_catalog.current_setting('app.organization_id', true),
    ''
  );
  v_user_id text := NULLIF(pg_catalog.current_setting('app.user_id', true), '');
BEGIN
  IF v_organization_id IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'creating a matter requires an organization member'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.member m
    WHERE m.organization_id = v_organization_id
      AND m.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'creating a matter requires an organization member'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The function runs as the owner, so it checks what the row policies would:
  -- the client and the lead belong to the same organization.
  IF p_client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.contacts c
    WHERE c.id = p_client_id
      AND c.organization_id = v_organization_id
  ) THEN
    RAISE EXCEPTION 'the client belongs to another organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF p_lead_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.member m
    WHERE m.organization_id = v_organization_id
      AND m.user_id = p_lead_user_id
  ) THEN
    RAISE EXCEPTION 'the matter lead is not an organization member'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  PERFORM public.stella_lock_matter_stewardship(jsonb_build_array(jsonb_build_object(
    'organization_id', v_organization_id, 'workspace_ids', ARRAY[p_workspace_id],
    'user_ids', array_remove(ARRAY[v_user_id, p_lead_user_id], NULL)
  )), 'update');

  INSERT INTO public.workspaces (
    id,
    organization_id,
    client_id,
    name,
    reference,
    billing_reference,
    color,
    lead_user_id,
    visibility
  )
  VALUES (
    p_workspace_id,
    v_organization_id,
    p_client_id,
    p_name,
    p_reference,
    p_billing_reference,
    p_color,
    p_lead_user_id,
    p_visibility
  );

  IF NOT public.stella_workspace_access(
    v_organization_id,
    v_user_id,
    p_workspace_id
  ) THEN
    -- The application mints ids for its own inserts; the column has no
    -- database default, so the function supplies one.
    INSERT INTO public.workspace_members (id, workspace_id, user_id)
    VALUES (pg_catalog.gen_random_uuid(), p_workspace_id, v_user_id);
  END IF;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_create_workspace(uuid, uuid, text, text, text, text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_create_workspace(uuid, uuid, text, text, text, text, text, text) TO stella;

--> statement-breakpoint

-- The online repair selects and holds only its bounded legacy batch; its
-- subsequent steward queries run after lock acquisition with a fresh snapshot.
CREATE FUNCTION public.stella_lock_legacy_visibility_batch(p_cursor uuid, p_size integer)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  requests jsonb;
BEGIN
  IF p_size < 1 OR p_size > 100 THEN
    RAISE EXCEPTION 'visibility backfill batch must contain between 1 and 100 matters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO requests FROM (
    SELECT organization_id, array_agg(batch.id ORDER BY batch.id) AS workspace_ids
    FROM (SELECT w.id, w.organization_id FROM public.workspaces w
      WHERE p_cursor IS NULL OR w.id > p_cursor ORDER BY w.id LIMIT p_size) batch
    GROUP BY organization_id
  ) r;
  PERFORM public.stella_lock_matter_stewardship(requests, 'update');
  RETURN QUERY SELECT w.id FROM public.workspaces w
    WHERE p_cursor IS NULL OR w.id > p_cursor ORDER BY w.id LIMIT p_size;
END;
$$;
--> statement-breakpoint

-- Only the database migration owner runs the repair; application sessions do not.
REVOKE ALL ON FUNCTION public.stella_lock_legacy_visibility_batch(uuid, integer) FROM PUBLIC;
--> statement-breakpoint

-- The migration owner repairs legacy stewardship and visibility in the same
-- bounded prefix. Application sessions cannot invoke this rollout operation.
CREATE FUNCTION public.stella_repair_legacy_visibility_batch(p_ids uuid[])
RETURNS void
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  requests jsonb;
BEGIN
  IF cardinality(p_ids) > 100 THEN
    RAISE EXCEPTION 'visibility repair batch cannot exceed 100 matters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO requests FROM (
    SELECT w.organization_id, array_agg(w.id ORDER BY w.id) AS workspace_ids
    FROM public.workspaces w WHERE w.id = ANY(p_ids)
    GROUP BY w.organization_id
  ) r;
  PERFORM public.stella_lock_matter_stewardship(requests, 'update');

  UPDATE public.workspaces AS w
  SET lead_user_id = steward.user_id
  FROM (
    SELECT DISTINCT ON (wm.workspace_id) wm.workspace_id, wm.user_id
    FROM public.workspace_members AS wm
    JOIN public.workspaces AS matter ON matter.id = wm.workspace_id
    JOIN public.member AS m
      ON m.user_id = wm.user_id AND m.organization_id = matter.organization_id
    WHERE matter.id = ANY(p_ids) AND matter.client_id IS NULL
      AND m.role IN ('owner', 'admin', 'member', 'intern')
      AND NOT EXISTS (
        SELECT 1 FROM public.workspace_members AS lead_assignment
        JOIN public.member AS lead_member
          ON lead_member.user_id = lead_assignment.user_id
          AND lead_member.organization_id = matter.organization_id
        WHERE lead_assignment.workspace_id = matter.id
          AND lead_assignment.user_id = matter.lead_user_id
          AND lead_member.role IN ('owner', 'admin', 'member', 'intern')
      )
    ORDER BY wm.workspace_id, wm.created_at, wm.id
  ) AS steward
  WHERE w.id = steward.workspace_id;

  UPDATE public.workspaces AS w
  SET visibility = CASE WHEN w.client_id IS NULL THEN 'assigned_only' ELSE 'admins_and_assigned' END
  WHERE w.id = ANY(p_ids) AND w.visibility IS DISTINCT FROM
    CASE WHEN w.client_id IS NULL THEN 'assigned_only' ELSE 'admins_and_assigned' END;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_repair_legacy_visibility_batch(uuid[]) FROM PUBLIC;
--> statement-breakpoint

-- The retained seven-argument creation API delegates to the same lock owner.
-- stella-migration-safety: reviewed security-definer - fixed search path and PUBLIC execute revoked; delegates to the tenant-bound creation procedure without adding authority
CREATE OR REPLACE FUNCTION public.stella_create_workspace(
  p_workspace_id uuid, p_client_id uuid, p_name text, p_reference text,
  p_billing_reference text, p_color text, p_lead_user_id text
) RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.stella_create_workspace(
    p_workspace_id, p_client_id, p_name, p_reference, p_billing_reference, p_color,
    CASE WHEN p_client_id IS NULL THEN COALESCE(p_lead_user_id, NULLIF(current_setting('app.user_id', true), '')) ELSE p_lead_user_id END,
    CASE WHEN p_client_id IS NULL THEN 'assigned_only' ELSE 'admins_and_assigned' END
  );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_create_workspace(uuid, uuid, text, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_create_workspace(uuid, uuid, text, text, text, text, text) TO stella;
--> statement-breakpoint
