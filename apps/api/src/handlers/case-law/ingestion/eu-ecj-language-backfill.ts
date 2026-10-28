/**
 * Fill in the language versions of EU decisions the corpus does not hold.
 *
 * The crawl lists a decision once, on the day it walks past its date, and the
 * reconciliation loop re-lists only its tip window and slices it already
 * knows to be short. A translation the listing could not see when the year
 * was surveyed (the Office publishes most translations as the Court's own
 * HTML before converting them to XHTML, and the listing used to ask for
 * XHTML only) therefore stays missing for every year outside the tip. This
 * job re-lists history one month at a time under the current listing, and
 * ingests exactly the (CELEX, language) variants no stored row holds.
 *
 * Replay-safe by construction:
 *
 * - the unit of progress is one listed month, and the durable cursor names
 *   the last month every missing variant of which reached a terminal outcome;
 * - a variant is written through the ingestion pipeline under its stable
 *   identity, so a replayed month re-lists, finds it held, and writes nothing;
 * - a retryable failure holds the cursor where it was, and the next run
 *   re-lists that month; a variant the publisher lists but does not serve is
 *   terminal and journaled rather than retried forever;
 * - the cursor advances by compare-and-set against the value the run loaded,
 *   so two overlapping runs cannot move it past work one of them skipped.
 *
 * The publisher, the store and the pipeline are injected so the walk's
 * fixed point and failure semantics are testable without either.
 */

import { panic } from "better-result";

import type { EcjCelexVariant } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";

/** A listed month, `YYYY-MM`; the unit of progress. */
export type EcjBackfillMonth = string;

const MONTH = /^(?<year>\d{4})-(?<month>0[1-9]|1[0-2])$/u;

export const isEcjBackfillMonth = (value: string): boolean => MONTH.test(value);

/** The month before `month`. */
export const previousEcjBackfillMonth = (
  month: EcjBackfillMonth,
): EcjBackfillMonth => {
  const groups = MONTH.exec(month)?.groups;
  if (groups === undefined) {
    return panic(`Not a backfill month: ${month}`);
  }
  const year = Number(groups["year"]);
  const index = Number(groups["month"]);
  return index === 1
    ? `${String(year - 1).padStart(4, "0")}-12`
    : `${String(year).padStart(4, "0")}-${String(index - 1).padStart(2, "0")}`;
};

/** What became of one variant the listing named and no row held. */
export type EcjVariantIngestOutcome =
  /** Written through the pipeline. */
  | { type: "written" }
  /** Listed but not served: terminal, journaled, never retried by this job. */
  | { type: "unavailable" }
  /** The publisher or the pipeline failed in a way a later run can fix. */
  | { type: "retryable"; reason: string };

export type EcjBackfillJournalEntry = {
  month: EcjBackfillMonth;
  celex: string;
  language: string;
  outcome: EcjVariantIngestOutcome["type"];
  reason?: string;
};

export type EcjLanguageBackfillSeams = {
  /** Every variant the publisher lists for one month. Throws on failure. */
  listMonth: (month: EcjBackfillMonth) => Promise<readonly EcjCelexVariant[]>;
  /** The stored identity of a variant, as the ingest keys it. */
  identityOf: (variant: EcjCelexVariant) => string | undefined;
  /** Which of these identities a stored row already holds. */
  heldIdentities: (identities: readonly string[]) => Promise<Set<string>>;
  /** Fetch and write one variant. */
  ingest: (variant: EcjCelexVariant) => Promise<EcjVariantIngestOutcome>;
  /** The last month finished, or null before the first. */
  loadCursor: () => Promise<EcjBackfillMonth | null>;
  /**
   * Record `next` as finished if the cursor still reads `expected`; false
   * when another run moved it first.
   */
  advanceCursor: (
    expected: EcjBackfillMonth | null,
    next: EcjBackfillMonth,
  ) => Promise<boolean>;
  /** Persist one variant's outcome before the cursor can pass it. */
  journal: (entry: EcjBackfillJournalEntry) => Promise<void>;
};

export type EcjLanguageBackfillOptions = EcjLanguageBackfillSeams & {
  /** The newest month to walk; the walk goes back from here. */
  newest: EcjBackfillMonth;
  /** The oldest month to walk, inclusive. */
  oldest: EcjBackfillMonth;
  /** Plan only: list and count, fetch and write nothing. */
  apply: boolean;
  /** Months this run may finish before it stops. */
  maxMonths: number;
  /** Variants this run may ingest before it stops. */
  maxIngests: number;
  signal?: AbortSignal | undefined;
};

export type EcjLanguageBackfillReport = {
  status:
    | "complete"
    | "month-budget"
    | "ingest-budget"
    | "held"
    | "superseded"
    | "aborted";
  /** The last month finished by any run, after this one. */
  cursor: EcjBackfillMonth | null;
  monthsWalked: number;
  listed: number;
  missing: number;
  written: number;
  unavailable: number;
  retryable: number;
  /** The month a retryable failure held, when one did. */
  heldAt?: EcjBackfillMonth;
};

const assertMonths = ({
  newest,
  oldest,
}: Pick<EcjLanguageBackfillOptions, "newest" | "oldest">): void => {
  if (!isEcjBackfillMonth(newest) || !isEcjBackfillMonth(oldest)) {
    panic(`Backfill months must be YYYY-MM: ${newest}, ${oldest}`);
  }
  if (oldest > newest) {
    panic(`Backfill oldest month ${oldest} is after newest ${newest}`);
  }
};

/**
 * Walk months from the one after the cursor (or `newest`) back to `oldest`,
 * ingesting what no row holds.
 */
export const runEcjLanguageBackfill = async (
  options: EcjLanguageBackfillOptions,
): Promise<EcjLanguageBackfillReport> => {
  assertMonths(options);
  const { newest, oldest, apply, maxMonths, maxIngests, signal } = options;
  let cursor = await options.loadCursor();
  const report: EcjLanguageBackfillReport = {
    status: "complete",
    cursor,
    monthsWalked: 0,
    listed: 0,
    missing: 0,
    written: 0,
    unavailable: 0,
    retryable: 0,
  };
  let month: EcjBackfillMonth =
    cursor === null || cursor > newest
      ? newest
      : previousEcjBackfillMonth(cursor);
  let ingests = 0;

  // A call rather than a property read: the signal flips while the walk awaits.
  const aborted = (): boolean => signal?.aborted === true;
  while (month >= oldest) {
    if (aborted()) {
      return { ...report, status: "aborted", cursor };
    }
    if (report.monthsWalked >= maxMonths) {
      return { ...report, status: "month-budget", cursor };
    }
    // db-await-in-loop: one listed month at a time, so the cursor names a
    // month whose every variant is terminal
    const listed = await options.listMonth(month);
    report.listed += listed.length;
    const keyed = listed.flatMap((variant) => {
      const identity = options.identityOf(variant);
      return identity === undefined ? [] : [{ variant, identity }];
    });
    const held = await options.heldIdentities(
      keyed.map(({ identity }) => identity),
    );
    const missing = keyed.filter(({ identity }) => !held.has(identity));
    report.missing += missing.length;

    if (apply) {
      for (const { variant } of missing) {
        if (aborted()) {
          return { ...report, status: "aborted", cursor };
        }
        if (ingests >= maxIngests) {
          // The month stays unfinished: the next run re-lists it and finds
          // what this one wrote already held.
          return { ...report, status: "ingest-budget", cursor };
        }
        ingests += 1;
        // db-await-in-loop: paced publisher fetch and pipeline write per variant
        const outcome = await options.ingest(variant);
        await options.journal({
          month,
          celex: variant.celex,
          language: variant.language,
          outcome: outcome.type,
          ...(outcome.type === "retryable" ? { reason: outcome.reason } : {}),
        });
        switch (outcome.type) {
          case "written":
            report.written += 1;
            break;
          case "unavailable":
            report.unavailable += 1;
            break;
          case "retryable":
            report.retryable += 1;
            return { ...report, status: "held", cursor, heldAt: month };
          default:
            outcome satisfies never;
            return panic("Unhandled backfill outcome");
        }
      }
    }
    report.monthsWalked += 1;
    if (apply) {
      const advanced = await options.advanceCursor(cursor, month);
      if (!advanced) {
        return {
          ...report,
          status: "superseded",
          cursor: await options.loadCursor(),
        };
      }
      cursor = month;
    }
    month = previousEcjBackfillMonth(month);
  }
  return { ...report, status: "complete", cursor };
};
