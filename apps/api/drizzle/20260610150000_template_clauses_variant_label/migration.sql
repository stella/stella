-- Snapshot of the linked variant's label, taken at link time. The
-- clause_variant_id FK is ON DELETE SET NULL, so without a snapshot a
-- deleted variant silently degrades the link to the clause head. The
-- label lets list/fill paths detect and surface the dangling variant.
ALTER TABLE "template_clauses" ADD COLUMN "clause_variant_label" varchar(256);
