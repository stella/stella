/**
 * The walk a queue reconciler makes over its own pending rows.
 *
 * A fixed first page cannot drain: a row the queue still owns keeps its
 * pending marker, so it refills the same page every tick and a row behind it
 * is never inspected. The sweep therefore pages forward on a keyset cursor
 * within one tick and stops on its own terms — enough rows handed back, the
 * table exhausted, or the page ceiling reached — rather than on the first
 * page's contents.
 */

import { panic } from "better-result";

import { parsePgTimestampCursorValue } from "@/api/lib/db-pagination";
import type { ParsedPgTimestampCursor } from "@/api/lib/db-pagination";

/** Rows read per page. */
export const RECONCILE_SCAN_PAGE_SIZE = 100;

/** Rows handed back per tick, so a backlog drains without a queue storm. */
const RECONCILE_HANDOFF_MAX = 50;

/**
 * Rows inspected at once. Each inspection is a couple of queue round trips, so
 * a whole page in flight would put a page's worth of commands on the broker
 * for a sweep that runs beside live traffic.
 */
const RECONCILE_SCAN_CONCURRENCY = 10;

/**
 * Pages one tick may walk. Bounds the work when nothing needs handing back,
 * which is the steady state: without it a large healthy backlog would cost one
 * queue lookup per row on every tick.
 */
const RECONCILE_MAX_PAGES = 20;

export type ReconcileScanResult = {
  handedOff: number;
  scanned: number;
};

/**
 * The cursor timestamp a page's keyset comparison is anchored on.
 *
 * A `Date` read back from the database cannot be that anchor: Postgres keeps
 * microseconds and a `Date` carries milliseconds, so the truncated value
 * re-admits the row the cursor came from (the walk never advances) or steps
 * over the row beside it (an orphan is never inspected). The page therefore
 * projects its cursor with `pgTimestampCursorValue` and re-anchors that text
 * here. Unparseable is impossible — the value comes straight from that
 * projection in the same query — so it is a programmer error, not a cursor to
 * recover from.
 */
export const reconcileCursorTimestamp = (
  cursorValue: string,
): ParsedPgTimestampCursor =>
  parsePgTimestampCursorValue(cursorValue) ??
  panic("Reconciliation cursor is not a database timestamp");

type ScanPendingRowsOptions<Row> = {
  /**
   * Acts on one row and reports whether it counted as a handoff. Every row it
   * receives counts as inspected whatever it answers, so a row it cannot act
   * on — an unusable actor, a queue lookup that failed — advances the cursor
   * instead of pinning the sweep to the page it sits on.
   */
  handle: (row: Row) => Promise<boolean>;
  /** Reads the next page after `cursor`, ordered by the same key. */
  readPage: (cursor: Row | null) => Promise<readonly Row[]>;
};

export const scanPendingRows = async <Row>({
  handle,
  readPage,
}: ScanPendingRowsOptions<Row>): Promise<ReconcileScanResult> => {
  let handedOff = 0;
  let scanned = 0;
  /**
   * Handoffs started but not yet known to have failed. Capacity is taken
   * before a handler runs, not counted after it returns: whether a row hands
   * off is only knowable once its handler is done, so a page started all at
   * once would already have made every one of its handoffs by the time the
   * limit was checked. A handler that turns out not to have handed off gives
   * its reservation back, so a page the queue already owns costs none of the
   * budget.
   */
  let reserved = 0;

  const runPage = async (rows: readonly Row[]): Promise<void> => {
    let next = 0;

    const runNext = async (): Promise<void> => {
      if (reserved >= RECONCILE_HANDOFF_MAX) {
        return;
      }
      const row = rows.at(next);
      if (row === undefined) {
        return;
      }
      next += 1;
      reserved += 1;
      const didHandOff = await handle(row);
      scanned += 1;
      if (didHandOff) {
        handedOff += 1;
      } else {
        reserved -= 1;
      }
      await runNext();
    };

    await Promise.all(
      Array.from({ length: RECONCILE_SCAN_CONCURRENCY }, runNext),
    );
  };

  const walk = async (cursor: Row | null, page: number): Promise<void> => {
    if (page >= RECONCILE_MAX_PAGES || reserved >= RECONCILE_HANDOFF_MAX) {
      return;
    }
    const rows = await readPage(cursor);
    const last = rows.at(-1);
    if (last === undefined) {
      return;
    }
    await runPage(rows);
    if (rows.length < RECONCILE_SCAN_PAGE_SIZE) {
      return;
    }
    await walk(last, page + 1);
  };

  await walk(null, 0);
  return { handedOff, scanned };
};
