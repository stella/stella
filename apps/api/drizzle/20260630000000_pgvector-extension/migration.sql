-- stella-migration-safety: reviewed additive-change extension-create
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;