SET lock_timeout = '1s';--> statement-breakpoint

-- Two set-based updates over roughly 29,000 rows rather than a catalog change,
-- so the budget is sized for the work instead of for DDL. `lock_timeout` stays
-- short: a ROW EXCLUSIVE lock that has to queue behind live traffic should fail
-- fast. `legislation_documents` is not one of the registered high-volume tables
-- (apps/api/src/db/high-volume-tables.ts), and both statements are bounded by
-- `country = 'SVK'`.
SET statement_timeout = '15min';--> statement-breakpoint

-- Slovak version windows stored with the publisher's inclusive closing date.
--
-- `legislation_documents.version_valid_to` is the exclusive end of the
-- half-open window `[version_valid_from, version_valid_to)`, and `storedWindow`
-- in apps/api/src/handlers/legislation/version-windows.ts is the one place a
-- publisher's "last day in force" is converted into it. The Slovak connector
-- stored that date unshifted until the conversion reached it, so its windows
-- close a day early: the last day each consolidation was in force is covered by
-- no version, and a point-in-time read of that day answers "uncovered" for a
-- text the corpus holds. A connector rewrites a row only when it revisits it,
-- so the rows written before the conversion still carry the publisher's
-- convention.
--
-- Two rules shift them, both by exactly one day.

-- Rule A, neighbour-proven: the row's immediate successor in the same
-- (eli, language) opens the day after the row closes. That is `inclusive-end`
-- in `windowJunction`, and the shift makes the junction contiguous. The
-- successor is the next window by opening date, not any window opening on
-- `version_valid_to + 1`: with a one-day consolidation in the chain the latter
-- reading matches its predecessor again after the shift and walks the closing
-- date forward on every run.
--
-- Overlaps and gaps are other junctions and are not one day short, so they are
-- left as they are.
--
-- Idempotent without a marker: after the shift the immediate successor opens on
-- the row's closing date, not the day after, so the condition clears itself.
-- `updated_at` is bumped for the projection, not for the rule; see rule B.
UPDATE "legislation_documents" AS shifted
SET
  "version_valid_to" = shifted."version_valid_to" + 1,
  "updated_at" = now()
WHERE shifted."country" = 'SVK'
  AND shifted."version_valid_from" IS NOT NULL
  AND shifted."version_valid_to" IS NOT NULL
  AND (
    SELECT successor."version_valid_from"
    FROM "legislation_documents" AS successor
    WHERE successor."eli" = shifted."eli"
      AND successor."language" = shifted."language"
      AND successor."version_valid_from" > shifted."version_valid_from"
    ORDER BY successor."version_valid_from"
    LIMIT 1
  ) = shifted."version_valid_to" + 1;--> statement-breakpoint

-- Rule B, successor-less: the row is closed and is the latest version of its
-- work, so no neighbour can witness the defect. The publisher's closing date is
-- inclusive by definition, so such a row carries the same one-day error as a
-- rule A row and takes the same shift; the evidence is the write time instead
-- of a neighbour.
--
-- 2026-09-21T20:27:00Z is when the converted connector started writing. Every
-- Slovak row that closes one day before its successor opens was written before
-- that moment, and no row written after it does, so the timestamp separates the
-- two conventions on this corpus.
--
-- Idempotence: the shift sets `updated_at = now()`, which is past the cutoff,
-- so a second run skips the row. The alternative was a dedicated marker column,
-- dead weight the moment this lands; `updated_at` already means "when this row
-- was last written", and every consumer wants the bump. The search projection
-- walk in apps/api/src/handlers/legislation/search-index.ts reindexes a
-- document whose `updated_at` overtakes its search row, which is exactly the
-- set whose window changed; the statute sitemap's `lastmod` follows the change;
-- and the corpus backfill's compare-and-swap token re-reads. Rule A bumps it
-- for the same reason.
--
-- `version_valid_to >= version_valid_from` keeps the rule off a reversed
-- window, which is a different defect and is not one day short. Rule A needs no
-- such guard: a successor that opens both after `version_valid_from` and on
-- `version_valid_to + 1` already implies it.
UPDATE "legislation_documents" AS shifted
SET
  "version_valid_to" = shifted."version_valid_to" + 1,
  "updated_at" = now()
WHERE shifted."country" = 'SVK'
  AND shifted."version_valid_from" IS NOT NULL
  AND shifted."version_valid_to" IS NOT NULL
  AND shifted."version_valid_to" >= shifted."version_valid_from"
  AND shifted."updated_at" < TIMESTAMPTZ '2026-09-21 20:27:00+00'
  AND NOT EXISTS (
    SELECT 1
    FROM "legislation_documents" AS successor
    WHERE successor."eli" = shifted."eli"
      AND successor."language" = shifted."language"
      AND successor."version_valid_from" > shifted."version_valid_from"
  );
