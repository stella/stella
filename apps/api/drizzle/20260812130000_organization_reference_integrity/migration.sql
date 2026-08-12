SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Give the last seven organization_id columns a foreign key to organization.
-- These tables carried the column for row-level security alone: the value was
-- an authorization input the database could not check, so a row could name a
-- tenant that never existed and nothing would say so. Every other
-- organization_id in the schema already references organization(id) ON DELETE
-- CASCADE. This is that same consistency one layer below the org-pinned
-- policies added in 20260812110000, and it narrows nothing the application
-- relies on: every writer already supplies the organization of its own scoped
-- transaction.
--
-- ON DELETE CASCADE on all seven, matching every sibling. Per table:
--
--   pending_uploads
--     Five-minute upload reservations. Its workspace_id already cascades from
--     workspaces, so a tenant delete removed these transitively; the direct
--     edge closes the case where organization_id disagrees with that workspace.
--
--   entity_deletion_cleanup_requests, buffer_object_cleanup_intents
--     Durable storage-erasure work. Both deliberately keep no entity,
--     workspace, or user reference so a retry can finish erasing objects after
--     the row's subject is gone. The tenant root is the one ancestor whose
--     disappearance also ends the work, so it is the one ancestor they should
--     reference.
--
--   search_projection_repair_queue
--     source_id stays unreferenced by design: a mark whose source is gone is
--     work to discard on the next drain, not an error to prevent. Tenancy is a
--     separate question and gets the real edge.
--
--   search_document_preview_passages,
--   contact_search_document_preview_passages,
--   workspace_search_document_preview_passages
--     Projections that already cascade from the search document they preview.
--     The organization edge states the tenant path directly instead of leaving
--     it implied by the parent chain, which is what the policies read.
--
-- No index is added on the referencing side. The three queues drain to empty,
-- and the four projection tables already lead a scope index with
-- organization_id, so the cascade has an access path everywhere it matters.
--
-- Constraint names are given explicitly rather than left to drizzle: six of the
-- seven generated names exceed PostgreSQL's 63-byte identifier limit and would
-- be truncated server-side, reintroducing the schema/catalog divergence this
-- migration exists to remove. Each statement is one line because squawk
-- anchors a suppression to the line directly above the statement it reports.

-- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint -- entity_deletion_cleanup_requests is an outbox that drains to empty; its steady-state row count is the erasure work currently in flight, so the scan is bounded by the deploy-time backlog rather than by tenant data.
ALTER TABLE "entity_deletion_cleanup_requests" ADD CONSTRAINT "entity_deletion_cleanup_requests_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization" ("id") ON DELETE CASCADE;--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint -- buffer_object_cleanup_intents is an outbox that drains to empty; each row is one interrupted object write awaiting confirmation, so the scan is bounded by the deploy-time backlog rather than by tenant data.
ALTER TABLE "buffer_object_cleanup_intents" ADD CONSTRAINT "buffer_object_cleanup_intents_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization" ("id") ON DELETE CASCADE;--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint -- search_projection_repair_queue holds at most one row per stale source and the drain deletes each row it repairs, so the table is bounded by the sources currently behind, not by the corpus.
ALTER TABLE "search_projection_repair_queue" ADD CONSTRAINT "search_projection_repair_queue_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization" ("id") ON DELETE CASCADE;--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint -- contact_search_document_preview_passages holds a handful of passages per contact, and contact records are short enough that nearly every contact produces exactly one, so the table is bounded by the contact count.
ALTER TABLE "contact_search_document_preview_passages" ADD CONSTRAINT "contact_search_document_preview_passages_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization" ("id") ON DELETE CASCADE;--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint -- workspace_search_document_preview_passages previews a workspace's own title and reference, so it holds roughly one row per workspace and is bounded by the workspace count.
ALTER TABLE "workspace_search_document_preview_passages" ADD CONSTRAINT "workspace_search_document_preview_passages_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization" ("id") ON DELETE CASCADE;--> statement-breakpoint

-- The two remaining tables grow with tenant document volume rather than with a
-- backlog, so neither gets an inline validation.
--
-- search_document_preview_passages holds one row per passage per indexed
-- entity: unlike the contact and workspace projections it scales with the
-- document corpus, so it is treated like pending_uploads rather than like its
-- two siblings above.
--
-- Honest caveat on the shape below: the migrator wraps this file in a single
-- transaction, so the ACCESS EXCLUSIVE lock the ADD takes is held until commit
-- and the VALIDATE scan runs under it. The split is therefore the right shape
-- but not yet the right lock profile, which is what squawk reports and what the
-- suppressions below acknowledge. Both tables are expected to validate well
-- inside the 5s statement_timeout set above; if either ever times out, the fix
-- is to move its VALIDATE into its own migration directory so the scan runs in
-- a separate transaction under SHARE UPDATE EXCLUSIVE, exactly as 20260808008000
-- and 20260808009000 do for ai_memories. Deliberately not pre-splitting: a
-- second migration validating a constraint nothing has had time to violate is
-- cost without a reader.

ALTER TABLE "search_document_preview_passages" ADD CONSTRAINT "search_document_preview_passages_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization" ("id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- same-transaction validation, acknowledged above.
ALTER TABLE "search_document_preview_passages" VALIDATE CONSTRAINT "search_document_preview_passages_organization_fk";--> statement-breakpoint

ALTER TABLE "pending_uploads" ADD CONSTRAINT "pending_uploads_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization" ("id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- same-transaction validation, acknowledged above.
ALTER TABLE "pending_uploads" VALIDATE CONSTRAINT "pending_uploads_organization_fk";
