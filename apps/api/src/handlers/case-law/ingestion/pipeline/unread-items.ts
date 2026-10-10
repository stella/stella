import { panic, Result } from "better-result";
/**
 * Listed items whose read did not produce them, and what each costs the page.
 *
 * An `unavailable` read holds the page's cursor, so the next cycle asks
 * again. That is bounded per item: once the same item has been unavailable
 * for {@link UNAVAILABLE_CYCLES_BEFORE_MARKING} consecutive cycles in which
 * nothing else held the page, its listing-only row is stored with the typed
 * outcome and the page advances; the reconciliation re-asks on its own
 * cadence. A row that already holds its detail keeps it: the write records
 * the outcome in its metadata and nothing else. A `refused` read is terminal
 * at once and is stored typed, never counted.
 *
 * The consecutive counts live in the source row's `config` under
 * {@link UNAVAILABLE_ITEMS_CONFIG_KEY}, beside the cursor they hold. Only the
 * held page's items are kept, so the state is bounded by one page, and it is
 * cleared when the page advances. A successful read drops the item from the
 * page's unread set, which resets its count.
 */
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

// parser-output-unchanged: SHA-256 ownership changes preserve input bytes, serialization and update order, so stored hashes and parser output remain identical.
import { createSha256 } from "@stll/sha256/bun";

import type { IngestionScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  toPlainTextMetadataObject,
  type PlainTextMetadataValue,
} from "@/api/lib/case-law/plain-text";
import {
  READ_OUTCOME_METADATA_KEY,
  storedReadUnavailable,
  UNAVAILABLE_CYCLES_BEFORE_MARKING,
  type StoredReadOutcome,
} from "@/api/lib/errors/read-outcome";
import type {
  IngestionResult,
  UnreadListedItem,
  UnreadOutcome,
} from "@/api/lib/legal-search/ingestion-types";
import { logger } from "@/api/lib/observability/logger";

/** The `case_law_sources.config` key that holds the counts. */
export const UNAVAILABLE_ITEMS_CONFIG_KEY = "unavailableItems";

/** Consecutive unavailable cycles per `sourceDocumentId`. */
export type UnavailableStreaks = Readonly<Record<string, number>>;

const streaksSchema = v.record(
  v.string(),
  v.pipe(v.number(), v.integer(), v.minValue(1)),
);

type ReadStreaksResult =
  | { type: "read"; streaks: UnavailableStreaks }
  | { type: "malformed"; issues: string };

/** The counts a source row holds; none when the key is absent. */
export const readUnavailableStreaks = (
  config: Record<string, unknown> | null,
): ReadStreaksResult => {
  const stored = config?.[UNAVAILABLE_ITEMS_CONFIG_KEY];
  if (stored === undefined) {
    return { type: "read", streaks: {} };
  }
  const parsed = v.safeParse(streaksSchema, stored);
  return parsed.success
    ? { type: "read", streaks: parsed.output }
    : { type: "malformed", issues: v.summarize(parsed.issues) };
};

/**
 * The counts a run starts from. Malformed counts are reported and counted
 * again from zero; the next write replaces them.
 */
export const loadUnavailableStreaks = ({
  adapterKey,
  config,
}: {
  adapterKey: string;
  config: Record<string, unknown> | null;
}): UnavailableStreaks => {
  const stored = readUnavailableStreaks(config);
  switch (stored.type) {
    case "read":
      return stored.streaks;
    case "malformed":
      logger.warn("case_law.ingestion.unavailable_items_malformed", {
        adapterKey,
        issues: stored.issues,
      });
      return {};
    default:
      stored satisfies never;
      return panic(`Unhandled stored counts: ${String(stored)}`);
  }
};

/** The outcome as stored under `READ_OUTCOME_METADATA_KEY`. */
const storedOutcome = (
  outcome: UnreadOutcome,
  consecutiveCycles: number,
): StoredReadOutcome => {
  switch (outcome.type) {
    case "unavailable":
      return storedReadUnavailable({
        cause: outcome.cause,
        scope: "document",
        consecutiveCycles,
      });
    case "refused":
      return {
        type: outcome.type,
        status: outcome.status,
        scope: outcome.scope,
        cause: outcome.cause,
      };
    default:
      outcome satisfies never;
      return panic(`Unhandled unread outcome: ${String(outcome)}`);
  }
};

const contentHash = (input: string): string =>
  createSha256().update(input).digest("hex");

/**
 * The listing-only row an unread item stores: the adapter's listing with the
 * typed outcome in its metadata. The outcome joins the hash, so a row an
 * earlier listing-only observation stored is rewritten to carry it.
 */
const terminalListing = (
  { listing, outcome }: UnreadListedItem,
  consecutiveCycles: number,
): IngestionResult => {
  const stored = storedOutcome(outcome, consecutiveCycles);
  const metadata = toPlainTextMetadataObject({
    [READ_OUTCOME_METADATA_KEY]: stored,
  });
  if (Result.isError(metadata)) {
    return panic(
      `Unread outcome is not plain metadata: ${metadata.error.message}`,
    );
  }
  return {
    ...listing,
    metadata: { ...listing.metadata, ...metadata.value },
    rawHash: contentHash(`${listing.rawHash}|${JSON.stringify(stored)}`),
  };
};

const EMPTY_UNREAD_ITEMS: readonly UnreadListedItem[] = [];

export type UnreadPagePlan = {
  /** Rows to store now: refusals, and items whose unavailability is spent. */
  terminal: IngestionResult[];
  /** The page's unavailable items and their consecutive cycles, this one included. */
  streaks: UnavailableStreaks;
  /** Unavailable items still under the limit; the page holds while any is. */
  holding: number;
};

/**
 * What a page's unread items cost it this cycle, given the counts the
 * previous cycles left. Pure, so the state machine is testable on its own.
 *
 * A spent item stays counted at the limit while another item holds the page:
 * counting it from zero again would let two items take turns holding it.
 */
export const planUnreadItems = (
  items: readonly UnreadListedItem[] | undefined,
  prior: UnavailableStreaks,
): UnreadPagePlan => {
  const terminal: IngestionResult[] = [];
  const streaks = new Map<string, number>();
  let holding = 0;
  for (const item of items ?? EMPTY_UNREAD_ITEMS) {
    switch (item.outcome.type) {
      case "refused":
        terminal.push(terminalListing(item, 1));
        break;
      case "unavailable": {
        const id = item.listing.sourceDocumentId;
        const cycles = Math.min(
          (prior[id] ?? 0) + 1,
          UNAVAILABLE_CYCLES_BEFORE_MARKING,
        );
        streaks.set(id, cycles);
        if (cycles < UNAVAILABLE_CYCLES_BEFORE_MARKING) {
          holding += 1;
          break;
        }
        terminal.push(terminalListing(item, cycles));
        break;
      }
      default:
        item.outcome satisfies never;
        return panic(`Unhandled unread outcome: ${String(item.outcome)}`);
    }
  }
  return {
    terminal,
    streaks: holding === 0 ? {} : Object.fromEntries(streaks),
    holding,
  };
};

type WriteStreaksOptions = {
  scopedDb: IngestionScopedDb;
  sourceId: SafeId<"caseLawSource">;
  leaseToken: SafeId<"caseLawSourceIngestionLease">;
  streaks: UnavailableStreaks;
};

/**
 * Store the counts under the source's lease; an empty set removes the key.
 * Returns whether the lease still held the row.
 */
export const writeUnavailableStreaks = async ({
  scopedDb,
  sourceId,
  leaseToken,
  streaks,
}: WriteStreaksOptions): Promise<boolean> => {
  const config =
    Object.keys(streaks).length === 0
      ? sql`coalesce(${caseLawSources.config}, '{}'::jsonb) - ${UNAVAILABLE_ITEMS_CONFIG_KEY}::text`
      : sql`jsonb_set(coalesce(${caseLawSources.config}, '{}'::jsonb), ${`{${UNAVAILABLE_ITEMS_CONFIG_KEY}}`}::text[], ${JSON.stringify(streaks)}::text::jsonb)`;
  const written = await scopedDb(
    async (tx) =>
      // audit: skip — public case-law corpus bookkeeping, no workspace data
      await tx
        .update(caseLawSources)
        .set({ config })
        .where(
          and(
            eq(caseLawSources.id, sourceId),
            eq(caseLawSources.ingestionLeaseToken, leaseToken),
            sql`${caseLawSources.ingestionLeaseExpiresAt} > now()`,
          ),
        )
        .returning({ id: caseLawSources.id }),
  );
  return written.length > 0;
};

/** Whether two count sets are the same, so an unchanged one is not rewritten. */
export const sameStreaks = (
  left: UnavailableStreaks,
  right: UnavailableStreaks,
): boolean => {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
};

/** The stored outcome a result carries, for a write that keeps the row's detail. */
export const unreadOutcomeOf = (
  result: IngestionResult,
): PlainTextMetadataValue => result.metadata[READ_OUTCOME_METADATA_KEY];
