SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Give eleven constraints a name PostgreSQL can actually store.
--
-- PostgreSQL truncates any identifier past 63 bytes. Eleven migrations asked
-- for a longer constraint name, so what the catalog holds is the first 63
-- bytes and what the schema declares is the full string. Nothing failed: the
-- constraints work, and each is enforced exactly as intended. What broke is
-- the agreement between the declared schema and the catalog, which is what
-- `db:push --explain` reads to report drift and what any future statement
-- naming one of these constraints would rely on.
--
-- Every rename below is FROM the truncated name, because that is the name the
-- database has. The new names are explicit and short, in the same
-- `<table>_<subject>_fk` form already used for the constraints that were named
-- by hand, and the schema declarations are updated to match in the same
-- change. Renaming a constraint rewrites one catalog row: no lock beyond the
-- brief ACCESS EXCLUSIVE on the table, no scan, no data touched.
--
-- The class is closed by the ≤63-byte assertion in
-- apps/api/src/tests/security/schema-invariants.test.ts, which fails on any
-- new declaration that PostgreSQL would silently shorten.
--
-- Each statement is one line because squawk anchors a suppression to the line
-- directly above the statement it reports.

-- stella-migration-safety: reviewed destructive-change - every statement is a constraint rename, not a drop: the constraint keeps its columns, referenced table, and delete action, and only its catalog name changes to the value the schema already intends. Rollback is the inverse rename with the matching application revision.

ALTER TABLE "anonymization_allowlist_entries" RENAME CONSTRAINT "anonymization_allowlist_entries_organization_id_organization_id" TO "anonymization_allowlist_entries_organization_fk";--> statement-breakpoint

ALTER TABLE "anonymization_blacklist_entries" RENAME CONSTRAINT "anonymization_blacklist_entries_organization_id_organization_id" TO "anonymization_blacklist_entries_organization_fk";--> statement-breakpoint

ALTER TABLE "cell_metadata" RENAME CONSTRAINT "cell_metadata_property_id_workspace_id_properties_id_workspace_" TO "cell_metadata_property_workspace_fk";--> statement-breakpoint

ALTER TABLE "chat_thread_compactions" RENAME CONSTRAINT "chat_thread_compactions_first_kept_message_id_chat_messages_id_" TO "chat_thread_compactions_first_kept_message_fk";--> statement-breakpoint

ALTER TABLE "chat_thread_compactions" RENAME CONSTRAINT "chat_thread_compactions_first_summarized_message_id_chat_messag" TO "chat_thread_compactions_first_summarized_message_fk";--> statement-breakpoint

ALTER TABLE "chat_thread_compactions" RENAME CONSTRAINT "chat_thread_compactions_last_summarized_message_id_chat_message" TO "chat_thread_compactions_last_summarized_message_fk";--> statement-breakpoint

ALTER TABLE "desktop_edit_handoffs" RENAME CONSTRAINT "desktop_edit_handoffs_desktop_session_id_desktop_edit_sessions_" TO "desktop_edit_handoffs_desktop_session_fk";--> statement-breakpoint

ALTER TABLE "file_chat_threads" RENAME CONSTRAINT "file_chat_threads_entity_id_workspace_id_entities_id_workspace_" TO "file_chat_threads_entity_workspace_fk";--> statement-breakpoint

ALTER TABLE "file_chat_threads" RENAME CONSTRAINT "file_chat_threads_field_id_workspace_id_fields_id_workspace_id_" TO "file_chat_threads_field_workspace_fk";--> statement-breakpoint

ALTER TABLE "folio_collab_sessions" RENAME CONSTRAINT "folio_collab_sessions_finalized_version_id_entity_versions_id_f" TO "folio_collab_sessions_finalized_version_fk";--> statement-breakpoint

ALTER TABLE "template_chat_threads" RENAME CONSTRAINT "template_chat_threads_template_id_organization_id_templates_id_" TO "template_chat_threads_template_organization_fk";
