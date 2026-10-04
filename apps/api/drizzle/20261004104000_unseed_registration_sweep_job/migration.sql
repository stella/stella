-- requires: 20261003124800_registration_retention
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- The application owns "scheduler_jobs": every boot upserts the jobs declared
-- in DECLARED_SCHEDULER_JOBS (apps/api/src/lib/scheduler/jobs.ts). The
-- registration retention migration also seeded this job with a next run of
-- now(), so a database migrated at deploy time and one migrated later held
-- different rows. Removing the seeded row leaves the code as the only writer:
-- the next boot recreates the job from its declaration, with its next run one
-- interval after that boot.
-- stella-migration-safety: reviewed delete-data - removes one scheduler job row by primary key; running tasks keep working and the next boot recreates it from code, so rollback needs no restore
DELETE FROM "scheduler_jobs" WHERE "id" = 'auth.sweepRegistrations.hour';
