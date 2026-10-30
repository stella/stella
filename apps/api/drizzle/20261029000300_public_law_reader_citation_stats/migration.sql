SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
GRANT SELECT (decision_id, direction, related_year, related_country, related_source_id, polarity, count)
  ON TABLE "case_law_decision_citation_stats" TO stella_public_law_reader;
--> statement-breakpoint
GRANT SELECT (decision_id, status)
  ON TABLE "case_law_decision_citation_stats_state" TO stella_public_law_reader;
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
