import { panic } from "better-result";

import {
  appendUnsigned,
  NumberColumn,
  PackedPostings,
} from "./compact-storage";

const HASH_RANGE = 4_294_967_296;
// A bounded fingerprint space controls edition residency. Collisions only add
// exact verifications; they never discard a neighbour.
const DELETE_HASH_BUCKETS = 1_048_576;
const HASH_RANGE_BIG = 4_294_967_296n;
const SHARDS = 256;
const PACKING_CHUNK = 4096;

/** Collisions add candidates only: exact edit distance owns acceptance. */
export const deletionKey = (text: string): number => {
  let hash = 2_166_136_261;
  for (const character of text) {
    hash = Math.imul(
      hash + (character.codePointAt(0) ?? panic("Missing deletion character")),
      16_777_619,
    );
  }
  return ((hash + HASH_RANGE) % HASH_RANGE) % DELETE_HASH_BUCKETS;
};

class DeletionKeys {
  private readonly hashes;
  private readonly shards;
  constructor(hashes: NumberColumn, shards: NumberColumn) {
    this.hashes = hashes;
    this.shards = shards;
  }
  get(key: number): number | undefined {
    const shard = key % SHARDS;
    let from = this.shards.get(shard);
    let to = this.shards.get(shard + 1);
    while (from < to) {
      const middle = Math.floor((from + to) / 2);
      const hash = this.hashes.get(middle);
      if (hash === key) {
        return middle;
      }
      if (hash < key) {
        from = middle + 1;
      } else {
        to = middle;
      }
    }
    return undefined;
  }
}

/** Append-only pairs avoid a mutable map and linked-list node per deletion.
 * Each shard sorts in native numeric storage, then packs delta-coded postings.
 */
export class BuildingDeletions {
  private readonly shards = Array.from({ length: SHARDS }, () => ({
    hashes: new NumberColumn(),
    ids: new NumberColumn(),
  }));
  add(hash: number, id: number): void {
    const shard = this.shards[hash % SHARDS] ?? panic("Missing deletion shard");
    shard.hashes.push(hash);
    shard.ids.push(id);
  }
  *compact() {
    const hashes = new NumberColumn();
    const shardOffsets = new NumberColumn();
    const offsets = new NumberColumn();
    const sizes = new NumberColumn();
    const values = new NumberColumn("byte");
    offsets.push(0);
    for (const [shardId, shard] of this.shards.entries()) {
      shardOffsets.push(hashes.length);
      const pairs = new BigUint64Array(shard.ids.length);
      for (let position = 0; position < pairs.length; position += 1) {
        pairs[position] =
          BigInt(shard.hashes.get(position)) * HASH_RANGE_BIG +
          BigInt(shard.ids.get(position));
        if (position % PACKING_CHUNK === 0) {
          yield;
        }
      }
      // Release the unsorted shard before allocating packed output.
      this.shards[shardId] = {
        hashes: new NumberColumn(),
        ids: new NumberColumn(),
      };
      pairs.sort();
      let previousHash: number | undefined;
      let previousId = 0;
      let count = 0;
      for (let position = 0; position < pairs.length; position += 1) {
        const pair = pairs[position] ?? panic("Missing deletion pair");
        const hash = Number(pair / HASH_RANGE_BIG);
        const id = Number(pair % HASH_RANGE_BIG);
        if (hash !== previousHash) {
          if (previousHash !== undefined) {
            sizes.push(count);
            offsets.push(values.length);
          }
          hashes.push(hash);
          previousHash = hash;
          previousId = 0;
          count = 0;
        }
        // An id can occur only once per hash: the caller deduplicates keys.
        appendUnsigned(values, id - previousId);
        previousId = id;
        count += 1;
        if (position % PACKING_CHUNK === 0) {
          yield;
        }
      }
      if (previousHash !== undefined) {
        sizes.push(count);
        offsets.push(values.length);
      }
      yield;
    }
    shardOffsets.push(hashes.length);
    return {
      keys: new DeletionKeys(hashes, shardOffsets),
      postings: new PackedPostings({ offsets, sizes, values }),
    };
  }
}
