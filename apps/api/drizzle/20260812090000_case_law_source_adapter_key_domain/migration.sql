SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- `adapter_key` is an unconstrained varchar, so the unique index makes the keys
-- distinct without restricting them to registered adapters. A retired source or
-- a mistyped seed key therefore adds a row the registry never knew about, and
-- the bounded complete read of this table (CASE_LAW_SOURCE_ROWS_BOUND, derived
-- from ADAPTER_KEYS) panics on a catalogue no API path can repair.
--
-- The accepted values mirror ADAPTER_KEYS in apps/api/src/lib/legal-search/
-- ingestion-constants.ts, which the schema derives its check from; registering
-- an adapter now requires a paired migration, which is the intended direction.
-- stella-migration-safety: reviewed constraint validation - case_law_sources is
-- an operator-seeded catalogue holding one row per registered adapter (nine at
-- most), so inline CHECK validation completes in microseconds and cannot block
-- under load.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "case_law_sources" ADD CONSTRAINT "case_law_sources_adapter_key_registered" CHECK (adapter_key IN ('cz-regional', 'cz-ns', 'cz-nss', 'cz-us', 'sk-courts', 'sk-us', 'pl-courts', 'at-courts', 'eu-ecj'));
