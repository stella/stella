SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Keep lock acquisition bounded, but do not interrupt metadata-only catalog work after PostgreSQL grants the lock.
-- stella-migration-safety: metadata-only-type-change
SET statement_timeout = 0;--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - widening varchar(1024) -> text is a metadata-only catalog change with no table rewrite or data loss; official legislation titles have no fixed maximum length. Rollback is to restore varchar(1024) only after proving every stored title fits.
ALTER TABLE "legislation_documents" ALTER COLUMN "title" SET DATA TYPE text;--> statement-breakpoint
SET statement_timeout = '5s';
