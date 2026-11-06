SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- The online phase builds case_law_decisions_sitemap_month_published_idx and
-- case_law_decisions_language_group_published_idx CONCURRENTLY after this
-- transaction commits, so a sitemap count reads a month and its language groups
-- off the index.
SELECT 1;
