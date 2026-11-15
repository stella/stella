SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Who decided each claim's verdict. Every claim graded before this column
-- was graded by the language model alone, which is what the constant default
-- records; adding it rewrites no rows.
ALTER TABLE "legal_list_claims" ADD COLUMN "decider" jsonb DEFAULT '{"kind":"llm","fallback":null}'::jsonb NOT NULL;
