import { panic, Result } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import { corpusMemberLayout } from "@/api/env-base";
import type { SafeId } from "@/api/lib/branded-types";
import {
  enqueueCaseLawCorpusUploadIntentCleanups,
  reserveCaseLawCorpusUploadIntents,
} from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import type {
  CaseLawCorpusUploadReservationInput,
  CaseLawCorpusUploadReservations,
} from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import {
  formatCorpusLocation,
  parseCorpusLocation,
} from "@/api/lib/legal-search/corpus-location";
import {
  corpusPackMemberWeight,
  CORPUS_PACK_MAX_BYTES,
  planCorpusPacks,
  putCorpusPacks,
} from "@/api/lib/legal-search/corpus-pack-writer";
import type {
  CorpusPackMemberInput,
  PackedMemberLocations,
} from "@/api/lib/legal-search/corpus-pack-writer";
import {
  corpusKeys,
  corpusPayloadFrames,
  planCorpusDocumentWrite,
  writeCorpusDocument,
} from "@/api/lib/legal-search/corpus-storage";
import type {
  CorpusPayload,
  WriteCorpusResult,
} from "@/api/lib/legal-search/corpus-storage";

/**
 * One ingestion batch, one transfer.
 *
 * The pipeline processes a page of decisions one at a time, and each one used
 * to PUT its three payloads as it went. Their bytes are all available before
 * any of them has to be durable, so the batch collects them instead: under
 * the `packs` layout they become members of a single immutable object, and
 * under `objects` they are written as the standalone objects the corpus has
 * always held. Which one a deployment runs is configuration, not a property
 * of this code path.
 *
 * Order, per pack: plan every decision (an unchanged or empty payload
 * contributes no member), encode one pack, reserve an upload intent for every
 * decision in it, transfer it, and drop its bytes. Only then does each
 * decision settle its row, under its own fence. A decision whose settlement
 * fails leaves its members in the pack unreferenced; its reservation is what
 * makes them discoverable, and reclaiming them never denies the addresses a
 * retry re-derives.
 *
 * A caller that truly has one decision opens a batch for that decision and
 * flushes it: the same path, rather than a second writer with its own rules.
 */

type CorpusPackSettleOutcome =
  /** The row now records the payload, or a newer write already did. */
  | { type: "settled" }
  /** The decision was redacted or removed while the batch was written. */
  | { type: "redacted-or-missing" }
  /** The row could not be settled now; the caller holds its cursor. */
  | { type: "retry" };

type CorpusPackSettle = (args: {
  intentId: SafeId<"caseLawCorpusUploadIntent">;
  /** The addresses to store, or null where the payload carries no document. */
  written: WriteCorpusResult | null;
}) => Promise<CorpusPackSettleOutcome>;

export type CorpusPackBatchEntry = {
  decisionId: SafeId<"caseLawDecision">;
  /** Partitions the pack key space; a batch writes one pack per value. */
  jurisdiction: string;
  payload: CorpusPayload;
  /** The corpus write the row already records, or null for none. */
  stored: WriteCorpusResult | null;
  /** Applies the row CAS under the decision's fence once the bytes are durable. */
  settle: CorpusPackSettle;
};

export type CorpusPackBatchOutcome =
  | { type: "settled" }
  | { type: "redacted-or-missing" }
  /** Another writer holds this decision's reservation. */
  | { type: "busy" }
  | { type: "retry" }
  | { type: "failed"; error: unknown };

export type CorpusPackBatchOutcomes = Map<
  SafeId<"caseLawDecision">,
  CorpusPackBatchOutcome
>;

export type CorpusPackBatch = {
  enqueue: (entry: CorpusPackBatchEntry) => void;
  /**
   * Write the batch and settle its rows. Every enqueued decision appears in
   * the result, so a caller can fold the outcomes back into its own. A
   * failure that stops the batch before its decisions have outcomes is
   * returned rather than raised: it is the batch's answer about this page,
   * not a fault of the loop that ran it.
   */
  flush: () => Promise<Result<CorpusPackBatchOutcomes, unknown>>;
};

/**
 * How a batch's payloads reach object storage.
 *
 * The layout and the client that serves it are one choice, so they travel as
 * one value: a `packs` batch never calls the object writer, an `objects`
 * batch never calls the pack transfer. Were they separable, a caller could
 * hand over a client this batch never reaches and the deployment's own bucket
 * client would serve the write instead — silently, because a default is not a
 * call site.
 */
export type CorpusTransfer =
  | { layout: "packs"; putPacks: typeof putCorpusPacks }
  | { layout: "objects"; writeObjects: typeof writeCorpusDocument };

/** What the deployment transfers through; the layout is configuration. */
export const deployedCorpusTransfer = (): CorpusTransfer => {
  const layout = corpusMemberLayout;
  switch (layout) {
    case "packs":
      return { layout, putPacks: putCorpusPacks };
    case "objects":
      return { layout, writeObjects: writeCorpusDocument };
    default:
      layout satisfies never;
      return panic(`Unhandled corpus member layout: ${String(layout)}`);
  }
};

export type CorpusPackBatchOptions = {
  scopedDb: ScopedDb;
  signal?: AbortSignal;
  /**
   * How this batch's payloads reach object storage. Production reads the
   * deployment; a test names the layout it exercises and the client that
   * serves it.
   */
  transfer?: CorpusTransfer;
};

type PlannedEntry = {
  entry: CorpusPackBatchEntry;
  /** The three payloads to transfer, or none for a decision that writes nothing. */
  members: CorpusPackMemberInput[];
  /** Where this decision's payloads will be once the transfer lands. */
  written: WriteCorpusResult | null;
  /** What the reservation owns; never null, so cleanup always has targets. */
  reserved: WriteCorpusResult;
  packKey: string | null;
};

const packedWrite = (
  locations: PackedMemberLocations,
  contentHash: string,
): WriteCorpusResult => ({
  textKey: formatCorpusLocation(
    locations.text ?? panic("Packed text member lost"),
  ),
  sectionsKey: formatCorpusLocation(
    locations.sections ?? panic("Packed sections member lost"),
  ),
  astKey: formatCorpusLocation(
    locations.ast ?? panic("Packed ast member lost"),
  ),
  contentHash,
});

/**
 * The one pack a decision's payloads went into.
 *
 * A reservation records a single pack key, so a decision spread over two
 * packs would leave the second owned by nothing. The planner keeps a
 * document whole; this reads that back rather than trusting it, because the
 * alternative to a crash here is bytes in storage no cleanup can claim.
 */
const solePackKey = (locations: PackedMemberLocations): string => {
  const keys = new Set(Object.values(locations).map(({ packKey }) => packKey));
  return keys.size === 1
    ? ([...keys].at(0) ?? panic("Packed member lost its pack"))
    : panic(
        `Packed members of one decision span ${keys.size} packs: ${[...keys].join(", ")}`,
      );
};

/**
 * The decisions that travel in one pack.
 *
 * A decision's three payloads stay together: they settle as one row, and an
 * address inside a pack the row does not otherwise reach into would leave the
 * reservation naming two packs. The writer holds to that too, so a decision
 * heavier than the ceiling is alone in its group and lands in one oversized
 * pack rather than being split. The bound counts what the writer will buffer,
 * footer included, so a group is one pack and a failed transfer costs the
 * decisions of one pack.
 */
const packedGroups = (planned: readonly PlannedEntry[]): PlannedEntry[][] => {
  const groups: PlannedEntry[][] = [];
  let current: PlannedEntry[] = [];
  let currentBytes = 0;
  for (const entry of planned) {
    if (entry.members.length === 0) {
      continue;
    }
    const weight = entry.members.reduce(
      (total, { bytes }) => total + corpusPackMemberWeight(bytes),
      0,
    );
    if (current.length > 0 && currentBytes + weight > CORPUS_PACK_MAX_BYTES) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += weight;
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
};

/** Reservations in a fixed order, so concurrent batches take rows alike. */
const reservationsFor = (
  planned: readonly PlannedEntry[],
): CaseLawCorpusUploadReservationInput[] =>
  [...planned]
    // Decision ids, not words: this fixes the order rows are locked in.
    .toSorted((left, right) =>
      left.entry.decisionId < right.entry.decisionId ? -1 : 1,
    )
    .map((entry) => ({
      contentHash: entry.reserved.contentHash,
      decisionId: entry.entry.decisionId,
      written: entry.written ?? entry.reserved,
      packKey: entry.packKey,
    }));

export const openCorpusPackBatch = ({
  scopedDb,
  signal,
  transfer = deployedCorpusTransfer(),
}: CorpusPackBatchOptions): CorpusPackBatch => {
  const entries: CorpusPackBatchEntry[] = [];
  const outcomes: CorpusPackBatchOutcomes = new Map();

  const settleReserved = async (
    planned: PlannedEntry,
    intentId: SafeId<"caseLawCorpusUploadIntent">,
  ): Promise<CorpusPackBatchOutcome> => {
    const settled = await Result.tryPromise({
      try: async () =>
        await planned.entry.settle({ intentId, written: planned.written }),
      catch: (cause) => cause,
    });
    if (Result.isError(settled)) {
      return { type: "failed", error: settled.error };
    }
    switch (settled.value.type) {
      case "settled":
        return { type: "settled" };
      case "redacted-or-missing":
        return { type: "redacted-or-missing" };
      case "retry":
        return { type: "retry" };
      default:
        settled.value satisfies never;
        return panic(`Unhandled settlement: ${String(settled.value)}`);
    }
  };

  /** Everything in this group failed the same way, for the same reason. */
  const failGroup = (group: readonly PlannedEntry[], error: unknown): void => {
    for (const { entry } of group) {
      outcomes.set(entry.decisionId, { type: "failed", error });
    }
  };

  const plan = async (
    entry: CorpusPackBatchEntry,
  ): Promise<PlannedEntry | null> => {
    const planned = planCorpusDocumentWrite({
      ...entry.payload,
      documentId: entry.decisionId,
      jurisdiction: entry.jurisdiction,
      stored: entry.stored,
    });
    switch (planned.type) {
      case "skipped-empty":
        // Nothing to store, but the row's mirror still has to settle, and the
        // reservation still owns the keys this write would have taken had the
        // payload carried a document.
        return {
          entry,
          members: [],
          written: null,
          reserved: {
            ...corpusKeys({
              documentId: entry.decisionId,
              jurisdiction: entry.jurisdiction,
              contentHash: planned.contentHash,
            }),
            contentHash: planned.contentHash,
          },
          packKey: null,
        };
      case "skipped-unchanged": {
        // The row keeps the addresses it has; where those are members of a
        // pack, the reservation names that pack so cleanup asks the same
        // liveness question about it as any other.
        const stored = parseCorpusLocation(planned.written.textKey);
        return {
          entry,
          members: [],
          written: planned.written,
          reserved: planned.written,
          packKey: stored.type === "packed" ? stored.packKey : null,
        };
      }
      case "put": {
        const frames = await corpusPayloadFrames(entry.payload);
        const member = (
          kind: CorpusPackMemberInput["kind"],
          bytes: Uint8Array,
        ): CorpusPackMemberInput => ({
          documentId: entry.decisionId,
          kind,
          contentHash: planned.written.contentHash,
          bytes,
        });
        return {
          entry,
          members: [
            member("text", frames.text),
            member("sections", frames.sections),
            member("ast", frames.ast),
          ],
          // Filled in by the transfer below, once the addresses exist.
          written: null,
          reserved: planned.written,
          packKey: null,
        };
      }
      default:
        planned satisfies never;
        return panic(`Unhandled corpus write plan: ${String(planned)}`);
    }
  };

  /**
   * Plan one pack, reserve its decisions, transfer it, and let its bytes go.
   * The reservation comes first because an object that lands while its rows
   * do not is only recoverable if something recorded that it was going to.
   */
  const transferPack = async (
    group: PlannedEntry[],
    putPacks: typeof putCorpusPacks,
  ): Promise<void> => {
    const jurisdiction =
      group.at(0)?.entry.jurisdiction ?? panic("Empty pack group");
    const packed = await planCorpusPacks({
      jurisdiction,
      documents: group.map(({ members }) => members),
    });
    if (Result.isError(packed)) {
      failGroup(group, packed.error);
      return;
    }
    for (const member of group) {
      const locations = packed.value.locations.get(member.entry.decisionId);
      if (locations === undefined) {
        return panic("Planned members lost their addresses");
      }
      member.written = packedWrite(locations, member.reserved.contentHash);
      member.packKey = solePackKey(locations);
    }
    const reserved = await reserveCaseLawCorpusUploadIntents({
      reservations: reservationsFor(group),
      scopedDb,
    });
    if (Result.isError(reserved)) {
      failGroup(group, reserved.error);
      return;
    }
    const transferred = await putPacks({
      packs: packed.value.packs,
      ...(signal === undefined ? {} : { signal }),
    });
    if (Result.isError(transferred)) {
      await releaseReservations(reserved.value);
      failGroup(group, transferred.error);
      return;
    }
    await settleGroup(group, reserved.value);
  };

  const releaseReservations = async (
    reserved: CaseLawCorpusUploadReservations,
  ): Promise<void> => {
    await enqueueCaseLawCorpusUploadIntentCleanups({
      intentIds: [...reserved.values()].flatMap((reservation) =>
        reservation.type === "reserved" ? [reservation.intentId] : [],
      ),
      scopedDb,
    });
  };

  /**
   * The object layout: three standalone objects per contributing decision.
   *
   * Nothing is shared here, so a write that fails is one decision's failure.
   * Failing its page-mates would reclaim objects that already landed, and a
   * decision that fails the same way on every attempt would take its whole
   * page down with it for ever.
   */
  const transferObjects = async (
    group: PlannedEntry[],
    writeObjects: typeof writeCorpusDocument,
  ): Promise<void> => {
    for (const entry of group) {
      entry.written = entry.reserved;
    }
    const reserved = await reserveCaseLawCorpusUploadIntents({
      reservations: reservationsFor(group),
      scopedDb,
    });
    if (Result.isError(reserved)) {
      failGroup(group, reserved.error);
      return;
    }
    const written: PlannedEntry[] = [];
    const abandoned: SafeId<"caseLawCorpusUploadIntent">[] = [];
    for (const entry of group) {
      const stored = await Result.tryPromise({
        try: async () =>
          await writeObjects(
            {
              ...entry.entry.payload,
              documentId: entry.entry.decisionId,
              jurisdiction: entry.entry.jurisdiction,
              stored: entry.entry.stored,
            },
            signal === undefined ? {} : { signal },
          ),
        catch: (cause) => cause,
      });
      if (Result.isOk(stored)) {
        written.push(entry);
        continue;
      }
      outcomes.set(entry.entry.decisionId, {
        type: "failed",
        error: stored.error,
      });
      const reservation = reserved.value.get(entry.entry.decisionId);
      if (reservation?.type === "reserved") {
        abandoned.push(reservation.intentId);
      }
    }
    if (abandoned.length > 0) {
      await enqueueCaseLawCorpusUploadIntentCleanups({
        intentIds: abandoned,
        scopedDb,
      });
    }
    await settleGroup(written, reserved.value);
  };

  const settleGroup = async (
    group: readonly PlannedEntry[],
    reserved: CaseLawCorpusUploadReservations,
  ): Promise<void> => {
    // Sequential on purpose: each settlement is one short transaction that
    // fences one decision against redaction, and the handle they run on is
    // the batch's own.
    const orphaned: SafeId<"caseLawCorpusUploadIntent">[] = [];
    for (const entry of group) {
      const reservation = reserved.get(entry.entry.decisionId);
      if (reservation === undefined || reservation.type === "redacted") {
        outcomes.set(entry.entry.decisionId, { type: "redacted-or-missing" });
        continue;
      }
      if (reservation.type === "busy") {
        outcomes.set(entry.entry.decisionId, { type: "busy" });
        continue;
      }
      // Each settlement is one short transaction fencing one decision, so
      // they are sequential by construction: the batch owns the handle and
      // the rows must be taken one at a time.
      const outcome = await settleReserved(entry, reservation.intentId);
      outcomes.set(entry.entry.decisionId, outcome);
      if (outcome.type === "failed") {
        orphaned.push(reservation.intentId);
      }
    }
    if (orphaned.length > 0) {
      await enqueueCaseLawCorpusUploadIntentCleanups({
        intentIds: orphaned,
        scopedDb,
      });
    }
  };

  return {
    enqueue: (entry) => {
      entries.push(entry);
    },
    flush: async () =>
      await Result.tryPromise({
        try: async () => {
          if (entries.length === 0) {
            return outcomes;
          }
          const planned: PlannedEntry[] = [];
          for (const entry of entries) {
            const prepared = await plan(entry);
            if (prepared !== null) {
              planned.push(prepared);
            }
          }
          entries.length = 0;

          const transferring = planned.filter(
            ({ members }) => members.length > 0,
          );
          if (transferring.length > 0) {
            switch (transfer.layout) {
              case "packs":
                // One pack per jurisdiction and per ceiling-sized group: the
                // key space is partitioned by jurisdiction, and the writer
                // buffers a whole pack before it transfers it.
                for (const [, group] of groupByJurisdiction(transferring)) {
                  for (const packGroup of packedGroups(group)) {
                    await transferPack(packGroup, transfer.putPacks);
                  }
                }
                break;
              case "objects":
                await transferObjects(transferring, transfer.writeObjects);
                break;
              default:
                transfer satisfies never;
                return panic(`Unhandled corpus transfer: ${String(transfer)}`);
            }
          }

          // A decision that stores nothing still settles its mirror, under a
          // reservation of its own.
          const settling = planned.filter(
            ({ members }) => members.length === 0,
          );
          if (settling.length > 0) {
            const reserved = await reserveCaseLawCorpusUploadIntents({
              reservations: reservationsFor(settling),
              scopedDb,
            });
            if (Result.isError(reserved)) {
              failGroup(settling, reserved.error);
            } else {
              await settleGroup(settling, reserved.value);
            }
          }
          return outcomes;
        },
        catch: (cause) => cause,
      }),
  };
};

const groupByJurisdiction = (
  planned: readonly PlannedEntry[],
): Map<string, PlannedEntry[]> => {
  const groups = new Map<string, PlannedEntry[]>();
  for (const plan of planned) {
    const forJurisdiction = groups.get(plan.entry.jurisdiction);
    if (forJurisdiction === undefined) {
      groups.set(plan.entry.jurisdiction, [plan]);
      continue;
    }
    forJurisdiction.push(plan);
  }
  return groups;
};
