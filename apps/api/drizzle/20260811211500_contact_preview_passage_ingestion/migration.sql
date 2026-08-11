-- stella-migration-safety: reviewed destructive-change - the replaced policy denied every request-role insert; this transactional migration restores it on rollback
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

GRANT INSERT ON TABLE "contact_search_document_preview_passages" TO stella;--> statement-breakpoint

DROP POLICY "contact_search_document_preview_passages_no_insert"
  ON "contact_search_document_preview_passages";--> statement-breakpoint

CREATE POLICY "contact_search_document_preview_passages_organization_insert"
  ON "contact_search_document_preview_passages" FOR INSERT TO stella
  WITH CHECK (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND EXISTS (
      SELECT 1
      FROM contact_search_documents parent
      WHERE parent.contact_id = contact_search_document_preview_passages.contact_id
        AND parent.organization_id = contact_search_document_preview_passages.organization_id
    )
  );
