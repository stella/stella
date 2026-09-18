import { Result } from "better-result";

import type { PackedCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import {
  CorpusPackError,
  encodePack,
  PACK_CONTENT_TYPE,
} from "@/api/lib/legal-search/corpus-pack";
import type {
  EncodedPack,
  PackMemberKind,
} from "@/api/lib/legal-search/corpus-pack";
import { CORPUS_TRANSFER_MAX_BYTES } from "@/api/lib/legal-search/corpus-storage";
import { LIMITS } from "@/api/lib/limits";
import {
  corpusS3ObjectExists,
  putCorpusS3ObjectWithSignal,
} from "@/api/lib/s3";
import { withTimeout } from "@/api/lib/with-timeout";

/**
 * The batch writer: one PUT carries every payload a batch produced.
 *
 * Callers hand over the members of a whole batch — several documents, several
 * kinds each — and receive the address of every member. A batch whose members
 * exceed {@link CORPUS_PACK_MAX_BYTES} is split into consecutive packs rather
 * than buffered into one object the writer would have to hold in memory
 * whole; nothing else splits a batch, so the number of packs a batch writes
 * is a function of its bytes alone.
 *
 * The key of each pack is derived from its members, so a batch replayed after
 * an ambiguous failure addresses the same object: the writer HEADs it and
 * skips the PUT when the store already holds it.
 */

/** Ceiling on one pack's bytes; the writer buffers a whole pack in memory. */
export const CORPUS_PACK_MAX_BYTES = 64 * 1024 * 1024;

export type CorpusPackMemberInput = {
  /** The document the member belongs to; addresses come back keyed by it. */
  documentId: string;
  kind: PackMemberKind;
  contentHash: string;
  bytes: Uint8Array;
};

/** A document's members of this batch, by kind. */
export type PackedMemberLocations = Partial<
  Record<PackMemberKind, PackedCorpusLocation>
>;

type WriteCorpusPackResult = {
  /** Every pack this batch landed, in the order it wrote them. */
  packKeys: string[];
  locations: Map<string, PackedMemberLocations>;
};

export type PlannedCorpusPacks = WriteCorpusPackResult & {
  /** The encoded packs, ready to transfer. */
  packs: EncodedPack[];
};

type PlanCorpusPacksOptions = {
  jurisdiction: string;
  members: readonly CorpusPackMemberInput[];
};

type PutCorpusPacksOptions = {
  packs: readonly EncodedPack[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test seams; production writes through the corpus bucket client. */
  put?: (key: string, bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
  exists?: (key: string) => Promise<boolean>;
};

const putPack = async (
  key: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> =>
  await putCorpusS3ObjectWithSignal(key, bytes, PACK_CONTENT_TYPE, signal);

/**
 * What one member costs the ceiling beyond its own bytes: its footer entry,
 * before the footer is compressed. Two ids, a kind, two digests and three
 * numbers of JSON, rounded up generously — the ceiling exists to bound a
 * buffer the writer holds whole, so the estimate has to sit above the truth
 * rather than near it.
 */
const FOOTER_BYTES_PER_MEMBER = 320;

/**
 * Split a batch's members into packs no larger than the ceiling, counting the
 * footer each member will carry: the writer buffers the whole object, so the
 * bound has to cover what it will hold, not only the payload bytes. A member
 * that exceeds the ceiling on its own still gets a pack — it is under the
 * per-member transfer ceiling, which is what a reader has to move.
 */
const packGroups = (
  members: readonly CorpusPackMemberInput[],
): CorpusPackMemberInput[][] => {
  const groups: CorpusPackMemberInput[][] = [];
  let current: CorpusPackMemberInput[] = [];
  let currentBytes = 0;
  for (const member of members) {
    const weight = member.bytes.byteLength + FOOTER_BYTES_PER_MEMBER;
    if (current.length > 0 && currentBytes + weight > CORPUS_PACK_MAX_BYTES) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(member);
    currentBytes += weight;
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
};

const oversizedMember = (
  members: readonly CorpusPackMemberInput[],
): CorpusPackMemberInput | undefined =>
  members.find(({ bytes }) => bytes.byteLength > CORPUS_TRANSFER_MAX_BYTES);

/**
 * Encode a batch's members and give every one of them its address.
 *
 * No transfer happens here. The addresses are derived from the members
 * themselves, so a caller can record what it is about to write — its upload
 * reservations — before anything leaves the process.
 */
export const planCorpusPacks = async ({
  jurisdiction,
  members,
}: PlanCorpusPacksOptions): Promise<
  Result<PlannedCorpusPacks, CorpusPackError>
> => {
  if (members.length === 0) {
    return Result.ok({ packs: [], packKeys: [], locations: new Map() });
  }
  const oversized = oversizedMember(members);
  if (oversized !== undefined) {
    return Result.err(
      new CorpusPackError({
        message: `Corpus pack member ${oversized.kind} for ${oversized.documentId} declares ${oversized.bytes.byteLength} bytes, past the ${CORPUS_TRANSFER_MAX_BYTES}-byte transfer ceiling`,
      }),
    );
  }
  const locations = new Map<string, PackedMemberLocations>();
  const packs: EncodedPack[] = [];
  for (const group of packGroups(members)) {
    const pack = await encodePack({ jurisdiction, members: group });
    packs.push(pack);
    for (const { member, location } of pack.entries) {
      const forDocument = locations.get(member.documentId) ?? {};
      forDocument[member.kind] = location;
      locations.set(member.documentId, forDocument);
    }
  }
  return Result.ok({
    packs,
    packKeys: packs.map(({ packKey }) => packKey),
    locations,
  });
};

/**
 * Transfer planned packs, one PUT each.
 *
 * Each key is content-addressed, so an object already under it holds exactly
 * these members: a replayed batch HEADs and transfers nothing.
 */
export const putCorpusPacks = async ({
  packs,
  signal,
  timeoutMs = LIMITS.corpusObjectIoTimeoutMs,
  put = putPack,
  exists = corpusS3ObjectExists,
}: PutCorpusPacksOptions): Promise<Result<void, CorpusPackError>> => {
  for (const pack of packs) {
    const written = await Result.tryPromise({
      try: async () => {
        const already = await withTimeout(
          async () => await exists(pack.packKey),
          { label: "corpus-pack-exists", signal, timeoutMs },
        );
        if (!already) {
          await withTimeout(
            async (writeSignal) =>
              await put(pack.packKey, pack.bytes, writeSignal),
            { label: "corpus-write-pack", signal, timeoutMs },
          );
        }
      },
      catch: (cause) =>
        new CorpusPackError({ message: "Corpus pack write failed", cause }),
    });
    if (Result.isError(written)) {
      return written;
    }
  }
  return Result.ok(undefined);
};

/**
 * What one member costs a pack's ceiling. A caller that decides which members
 * travel together asks this rather than counting payload bytes, so its bound
 * and the writer's are the same bound.
 */
export const corpusPackMemberWeight = (bytes: Uint8Array): number =>
  bytes.byteLength + FOOTER_BYTES_PER_MEMBER;
