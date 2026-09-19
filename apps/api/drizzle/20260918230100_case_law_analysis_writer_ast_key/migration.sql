SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The decision-analysis scripts select `ast_s3_key` to read a decision's parse
-- from the corpus, and the role they run as was never granted it, so every
-- statement naming the column was refused whole.
GRANT SELECT (ast_s3_key)
  ON TABLE "case_law_decisions"
  TO stella_case_law_analysis_writer;
