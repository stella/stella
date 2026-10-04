SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Every self-referencing tree keeps its parent chain acyclic in the database.
-- The registry in apps/api/src/lib/db/tree-parent-guard.ts owns the trigger
-- arguments; a test compares them with what is installed here.
--
-- Arguments: scope column, lock kind, lock namespace (or ''), constraint name.
-- Lock kinds are the lock each tree's writers already take first:
--   workspace-row         SELECT ... FROM workspaces WHERE id = scope FOR UPDATE
--   organization-catalog  pg_advisory_xact_lock(hashtext(scope))
--   advisory              pg_advisory_xact_lock(namespace, hashtext(scope))
-- A writer that already holds its tree's lock re-acquires it at no cost. The
-- lock is taken after the row being changed is locked, so writers take it
-- first in their own transaction and this one is the backstop.
--
-- The trigger runs AFTER each inserted or reparented row, when every row the
-- statement wrote is visible, so it sees a whole bulk statement: one INSERT of
-- A(parent B) and B(parent A) is refused like the same loop built by updates.
-- Every inserted or reparented row needs its parent in the same scope and a
-- parent chain that does not reach the row itself.
--
-- Parent-changing updates and inserts with a parent require READ COMMITTED;
-- stronger isolation retains the transaction snapshot after a lock wait.
-- A reparent locks the tree first and walks the chain on a fresh snapshot:
-- under the lock it sees every reparent committed before it, so two concurrent
-- moves cannot both close a loop. An INSERT takes no lock: rows that did not
-- exist before the statement can only be pointed at by rows of the same
-- transaction, so a loop through a new row is either inside one INSERT
-- statement (seen whole here) or closed by a reparent, which locks. Inserts
-- therefore never wait on, or add a lock to, the tree's writers.
-- Refusals raise check_violation (23514) naming the tree's constraint.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked below; runs only as the insert and parent-change trigger of the registered trees, writes nothing, reads only the parent chain of the changed row and takes that tree's existing lock on a reparent
CREATE FUNCTION "guard_tree_parent"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_scope_column text := TG_ARGV[0];
  v_lock_kind text := TG_ARGV[1];
  v_lock_namespace text := TG_ARGV[2];
  v_constraint text := TG_ARGV[3];
  v_scope text;
  v_parent_scope text;
  v_cycle boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN
    RETURN NULL;
  END IF;
  IF (TG_OP = 'UPDATE' OR NEW.parent_id IS NOT NULL)
    AND current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'tree parent writes require READ COMMITTED isolation'
      USING ERRCODE = 'check_violation', CONSTRAINT = v_constraint;
  END IF;
  IF NEW.parent_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'a tree row cannot be its own parent'
      USING ERRCODE = 'check_violation', CONSTRAINT = v_constraint;
  END IF;

  EXECUTE format('SELECT ($1).%I::text', v_scope_column)
    INTO v_scope USING NEW;

  IF TG_OP = 'UPDATE' THEN
    CASE v_lock_kind
      WHEN 'workspace-row' THEN
        PERFORM 1 FROM public.workspaces WHERE id = v_scope::uuid FOR UPDATE;
      WHEN 'organization-catalog' THEN
        PERFORM pg_advisory_xact_lock(hashtext(v_scope));
      WHEN 'advisory' THEN
        PERFORM pg_advisory_xact_lock(v_lock_namespace::integer, hashtext(v_scope));
      ELSE
        RAISE EXCEPTION 'unknown tree lock kind %', v_lock_kind;
    END CASE;
  END IF;

  EXECUTE format(
    'SELECT %I::text FROM %I.%I WHERE id = $1',
    v_scope_column, TG_TABLE_SCHEMA, TG_TABLE_NAME
  ) INTO v_parent_scope USING NEW.parent_id;
  IF v_parent_scope IS NOT NULL AND v_parent_scope <> v_scope THEN
    RAISE EXCEPTION 'a tree row cannot have a parent in another scope'
      USING ERRCODE = 'check_violation', CONSTRAINT = v_constraint;
  END IF;

  -- UNION (not UNION ALL) ends the walk on a loop stored before this guard.
  EXECUTE format(
    'WITH RECURSIVE chain(id) AS (
       SELECT node.id FROM %1$I.%2$I node WHERE node.id = $1
       UNION
       SELECT node.parent_id FROM %1$I.%2$I node
         JOIN chain ON node.id = chain.id
        WHERE node.parent_id IS NOT NULL
     )
     SELECT EXISTS (SELECT 1 FROM chain WHERE chain.id = $2)',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
  ) INTO v_cycle USING NEW.parent_id, NEW.id;
  IF v_cycle AND TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'inserted tree rows cannot form a loop'
      USING ERRCODE = 'check_violation', CONSTRAINT = v_constraint;
  END IF;
  IF v_cycle THEN
    RAISE EXCEPTION 'a tree row cannot move under its own descendant'
      USING ERRCODE = 'check_violation', CONSTRAINT = v_constraint;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "guard_tree_parent"() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "entities_parent_acyclic"
AFTER INSERT OR UPDATE OF "parent_id" ON "entities"
FOR EACH ROW EXECUTE FUNCTION "guard_tree_parent"('workspace_id', 'workspace-row', '', 'entities_parent_acyclic');--> statement-breakpoint

CREATE TRIGGER "clause_categories_parent_acyclic"
AFTER INSERT OR UPDATE OF "parent_id" ON "clause_categories"
FOR EACH ROW EXECUTE FUNCTION "guard_tree_parent"('organization_id', 'advisory', '1129071444', 'clause_categories_parent_acyclic');--> statement-breakpoint

CREATE TRIGGER "template_categories_parent_acyclic"
AFTER INSERT OR UPDATE OF "parent_id" ON "template_categories"
FOR EACH ROW EXECUTE FUNCTION "guard_tree_parent"('organization_id', 'organization-catalog', '', 'template_categories_parent_acyclic');
