import { inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_TOMBSTONE_REASON,
  caseLawCorpusPackRefs,
  caseLawCorpusTombstones,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import {
  formatCorpusLocation,
  parseCorpusLocation,
} from "@/api/lib/legal-search/corpus-location";
import type { PackedCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import { publicLawReadDb } from "@/api/lib/public-law-read-db";

/**
 * Reader denial for erased payloads that live inside a shared pack.
 *
 * Erasing a standalone corpus object deletes it. A packed member cannot be
 * deleted on its own — the pack holds other decisions' payloads — so the
 * erasure records the member's address as a tombstone and every read consults
 * this table before it asks the store for the range. The bytes stop being
 * served at the moment of the erasure; reclaiming them is a later rewrite of
 * the pack, which is what the recorded pack key is for.
 *
 * Only an erasure writes here. A reservation whose upload never landed owns
 * no bytes a reader was ever told about, and denying its planned addresses
 * would deny the retry that re-derives them.
 */

type CorpusTombstoneReason =
  (typeof CASE_LAW_CORPUS_TOMBSTONE_REASON)[keyof typeof CASE_LAW_CORPUS_TOMBSTONE_REASON];

export const CORPUS_TOMBSTONE_REASON = CASE_LAW_CORPUS_TOMBSTONE_REASON;

/** Which of these locations a reader must refuse. */
export type CorpusTombstoneReader = (
  locations: readonly string[],
) => Promise<ReadonlySet<string>>;

/**
 * Any handle that can answer the denial query: the ingestion transaction that
 * writes one, or the public read transaction that serves a decision.
 */
type CorpusTombstoneQueryTransaction = Pick<
  Transaction | CaseLawPublicReadTransaction,
  "select"
>;

/** A standalone object cannot be tombstoned: erasing it deletes it. */
const packedAddresses = (locations: readonly string[]): string[] =>
  locations.filter((value) => parseCorpusLocation(value).type === "packed");

/**
 * The denial list as the reader role sees it.
 *
 * Reads of public legal data run through the shared public-law boundary, so
 * the denial is asked for the same way the payload's own row is. That
 * boundary uses the reader role only where an external public-law database
 * URL is configured; otherwise it runs on the owner connection, and the grant
 * this table carries is what makes the configured deployment work.
 */
export const readCorpusTombstones: CorpusTombstoneReader = async (
  locations,
) => {
  const packed = packedAddresses(locations);
  if (packed.length === 0) {
    return new Set();
  }
  return await publicLawReadDb(async (tx) => {
    const rows = await tx
      .select({ location: caseLawCorpusTombstones.location })
      .from(caseLawCorpusTombstones)
      .where(inArray(caseLawCorpusTombstones.location, packed));
    return new Set(rows.map(({ location }) => location));
  });
};

/**
 * The same question inside a transaction the caller already holds.
 *
 * A read that is already inside one asks there rather than opening a second
 * connection of its own, which for a decision read is two transactions per
 * decision.
 */
export const corpusTombstoneReaderForTx =
  (tx: CorpusTombstoneQueryTransaction): CorpusTombstoneReader =>
  async (locations) => {
    const packed = packedAddresses(locations);
    if (packed.length === 0) {
      return new Set();
    }
    const rows = await tx
      .select({ location: caseLawCorpusTombstones.location })
      .from(caseLawCorpusTombstones)
      .where(inArray(caseLawCorpusTombstones.location, packed));
    return new Set(rows.map(({ location }) => location));
  };

/**
 * One query for a whole hydration.
 *
 * A decision is read as several members, and each read would otherwise ask
 * the table for its own address. The caller that knows every address it is
 * about to read asks once and hands the answer to each read.
 *
 * An address outside that set is asked about rather than assumed readable. A
 * read can be repointed while it runs — `readCorpusAtAuthoritativePointer`
 * rereads the row and follows a replacement pointer the hydration never saw —
 * and a miss that answered "not denied" would serve erased bytes. This is not
 * an impossible state, so it is a second query rather than a panic.
 */
export const prefetchCorpusTombstones = async (
  locations: readonly string[],
  read: CorpusTombstoneReader = readCorpusTombstones,
): Promise<CorpusTombstoneReader> => {
  const primed = new Set(packedAddresses(locations));
  const denied = await read([...primed]);
  return async (asked) => {
    const unprimed = packedAddresses(asked).filter(
      (value) => !primed.has(value),
    );
    const late =
      unprimed.length === 0 ? new Set<string>() : await read(unprimed);
    return new Set(
      asked.filter((value) => denied.has(value) || late.has(value)),
    );
  };
};

export type CorpusTombstoneEntry = {
  location: PackedCorpusLocation;
  decisionId: SafeId<"caseLawDecision">;
};

/**
 * Where an erasure records the members it could not delete. Required at every
 * delete call site rather than defaulted, so no path can erase a packed
 * payload without saying where the denial is written.
 */
export type CorpusTombstoneWriter = (
  entries: readonly CorpusTombstoneEntry[],
) => Promise<void>;

type CaseLawTombstoneWriterOptions = {
  scopedDb: ScopedDb;
  reason: CorpusTombstoneReason;
};

/**
 * Tombstone the members and drop the pack references they were reachable
 * through, in one transaction: a location nothing may serve is no longer a
 * reason to keep its pack alive, and a reference left behind would pin the
 * pack for a rewrite that has nothing to move. The pack key travels with the
 * denial, so the packs that owe a rewrite can be listed without parsing
 * addresses.
 */
const writeTombstonesTx = async (
  tx: Transaction,
  reason: CorpusTombstoneReason,
  entries: readonly CorpusTombstoneEntry[],
): Promise<void> => {
  const locations = entries.map(({ location }) =>
    formatCorpusLocation(location),
  );
  // audit: skip — erasure bookkeeping; the erasure itself is audited in
  // case_law_index_jobs by its caller
  await tx
    .insert(caseLawCorpusTombstones)
    .values(
      entries.map(({ location, decisionId }) => ({
        location: formatCorpusLocation(location),
        packKey: location.packKey,
        decisionId,
        reason,
      })),
    )
    .onConflictDoNothing();
  await tx
    .delete(caseLawCorpusPackRefs)
    .where(inArray(caseLawCorpusPackRefs.location, locations));
};

/** For a caller that erases outside a transaction of its own. */
export const caseLawCorpusTombstoneWriter =
  ({
    scopedDb,
    reason,
  }: CaseLawTombstoneWriterOptions): CorpusTombstoneWriter =>
  async (entries) => {
    if (entries.length > 0) {
      await scopedDb(
        async (tx) => await writeTombstonesTx(tx, reason, entries),
      );
    }
  };
