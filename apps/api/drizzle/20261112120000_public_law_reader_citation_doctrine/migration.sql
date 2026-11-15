SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
GRANT SELECT (citation_key, doctrinal_treatment)
  ON TABLE "case_law_citations" TO stella_public_law_reader;
--> statement-breakpoint
GRANT SELECT (citing_decision_id, citation_key, doctrinal_treatment, evidence_quote)
  ON TABLE "case_law_citation_doctrine_reviews" TO stella_public_law_reader;
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
