import { panic } from "better-result";

/* oxlint-disable no-bitwise -- Power-of-two columns and shards use masks on screening hot paths. */

// Fixed-size allocations avoid copying a growing column on the serving loop.
const COLUMN_CHUNK_SIZE = 4096;
const COLUMN_CHUNK_SHIFT = 12;
const COLUMN_CHUNK_MASK = COLUMN_CHUNK_SIZE - 1;
const MAP_SHARDS = 256;
const MAP_SHARD_MASK = MAP_SHARDS - 1;
const MAP_CHUNK_SIZE = 4096;

export class NumberColumn {
  private readonly chunks: (Uint8Array | Uint32Array | Float64Array)[] = [];
  private readonly kind;
  constructor(kind: "integer" | "float" | "byte" = "integer") {
    this.kind = kind;
  }
  length = 0;

  push(value: number): number {
    const index = this.length;
    if (index % COLUMN_CHUNK_SIZE === 0) {
      switch (this.kind) {
        case "float":
          this.chunks.push(new Float64Array(COLUMN_CHUNK_SIZE));
          break;
        case "byte":
          this.chunks.push(new Uint8Array(COLUMN_CHUNK_SIZE));
          break;
        case "integer":
          this.chunks.push(new Uint32Array(COLUMN_CHUNK_SIZE));
          break;
      }
    }
    this.length += 1;
    this.set(index, value);
    return index;
  }

  get(index: number): number {
    if (index < 0 || index >= this.length) {
      return panic("Missing compact column value");
    }
    return (
      this.chunks[index >>> COLUMN_CHUNK_SHIFT]?.[index & COLUMN_CHUNK_MASK] ??
      panic("Missing compact column chunk")
    );
  }

  getUnchecked(index: number): number {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- Paired compact columns emit every id passed here.
    return this.chunks[index >>> COLUMN_CHUNK_SHIFT]![
      index & COLUMN_CHUNK_MASK
    ]!;
  }

  byteChunk(index: number): Uint8Array {
    const chunk = this.chunks[index >>> COLUMN_CHUNK_SHIFT];
    return chunk instanceof Uint8Array
      ? chunk
      : panic("Missing compact byte chunk");
  }

  bytes(from: number, to: number): Uint8Array {
    const chunk = this.chunks[from >>> COLUMN_CHUNK_SHIFT];
    if (!(chunk instanceof Uint8Array)) {
      return panic("Missing compact byte chunk");
    }
    const localFrom = from & COLUMN_CHUNK_MASK;
    if (to - from <= chunk.length - localFrom) {
      return chunk.subarray(localFrom, localFrom + to - from);
    }
    return Uint8Array.from({ length: to - from }, (_, offset) =>
      this.get(from + offset),
    );
  }

  set(index: number, value: number): void {
    const chunk =
      this.chunks[index >>> COLUMN_CHUNK_SHIFT] ??
      panic("Missing compact column chunk");
    chunk[index & COLUMN_CHUNK_MASK] = value;
  }
}

export class ObjectColumn<T> {
  private readonly chunks: T[][] = [];
  length = 0;

  push(value: T): number {
    const index = this.length;
    if (index % COLUMN_CHUNK_SIZE === 0) {
      this.chunks.push([]);
    }
    const chunk = this.chunks.at(-1) ?? panic("Missing compact object chunk");
    chunk.push(value);
    this.length += 1;
    return index;
  }

  *[Symbol.iterator](): Generator<T, void, void> {
    for (let index = 0; index < this.length; index += 1) {
      yield this.get(index);
    }
  }

  *entries(): Generator<[number, T], void, void> {
    for (let index = 0; index < this.length; index += 1) {
      yield [index, this.get(index)];
    }
  }

  get(index: number): T {
    if (index < 0 || index >= this.length) {
      return panic("Missing compact object value");
    }
    const value =
      this.chunks[index >>> COLUMN_CHUNK_SHIFT]?.[index & COLUMN_CHUNK_MASK];
    // A stored null is a valid value (nullable entry fields); only an absent
    // slot is a broken column.
    if (value === undefined) {
      return panic("Missing compact object value");
    }
    return value;
  }
}

/** Each engine Map is capped, including adversarial hash collisions. */
export class StringMap<T> {
  private readonly shards = Array.from({ length: MAP_SHARDS }, () => [
    new Map<string, T>(),
  ]);

  private bucket(key: string): Map<string, T>[] {
    let hash = 0;
    for (let index = 0; index < key.length; index += 1) {
      // oxlint-disable-next-line unicorn/prefer-code-point -- UTF-16 code units are a stable, faster shard hash; equality remains Map-owned.
      hash = (hash * 31 + key.charCodeAt(index)) & MAP_SHARD_MASK;
    }
    return this.shards[hash] ?? panic("Missing compact map shard");
  }

  get(key: string): T | undefined {
    const maps = this.bucket(key);
    const first = maps[0]?.get(key);
    if (first !== undefined) {
      return first;
    }
    for (let index = 1; index < maps.length; index += 1) {
      const value = maps[index]?.get(key);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  }

  set(key: string, value: T): void {
    const maps = this.bucket(key);
    for (const map of maps) {
      if (map.has(key)) {
        map.set(key, value);
        return;
      }
    }
    let last = maps.at(-1) ?? panic("Missing compact map chunk");
    if (last.size >= MAP_CHUNK_SIZE) {
      last = new Map();
      maps.push(last);
    }
    last.set(key, value);
  }
}

/** UTF-8 storage for normalized spellings, which contain complete Unicode letters. */
export class SpellingColumn {
  private readonly offsets = new NumberColumn();
  private readonly values = new NumberColumn("byte");
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  constructor() {
    this.offsets.push(0);
  }
  get length(): number {
    return this.offsets.length - 1;
  }
  push(text: string): number {
    const id = this.length;
    for (const byte of this.encoder.encode(text)) {
      this.values.push(byte);
    }
    this.offsets.push(this.values.length);
    return id;
  }
  get(id: number): string {
    const from = this.offsets.get(id);
    const to = this.offsets.get(id + 1);
    return from === to ? "" : this.decoder.decode(this.values.bytes(from, to));
  }
}

export function* spellingColumnSteps(
  strings: ObjectColumn<string>,
): Generator<void, SpellingColumn, void> {
  const packed = new SpellingColumn();
  for (const text of strings) {
    packed.push(text);
    if (packed.length % COLUMN_CHUNK_SIZE === 0) {
      yield;
    }
  }
  return packed;
}

type IndexedStrings = { readonly length: number; get: (id: number) => string };
const HASH_RANGE = 4_294_967_296;
const stringHash = (key: string, capacity: number): number => {
  let hash = 0;
  for (const character of key) {
    hash =
      Math.imul(hash, 31) +
      (character.codePointAt(0) ?? panic("Missing string code point"));
  }
  // Mix high words into low words: related suffixes otherwise form long
  // clusters in the immutable lookup despite its low occupancy.
  hash = Math.imul(hash + Math.floor(hash / 65_536), 2_246_822_507);
  hash = Math.imul(hash + Math.floor(hash / 8192), 3_266_489_909);
  return (
    ((hash + Math.floor(hash / 65_536) + HASH_RANGE) % HASH_RANGE) % capacity
  );
};

const lookupCapacity = (count: number): number => {
  let candidate = Math.max(count * 2 + 1, 3);
  for (;;) {
    let prime = true;
    for (let divisor = 3; divisor * divisor <= candidate; divisor += 2) {
      if (candidate % divisor === 0) {
        prime = false;
        break;
      }
    }
    if (prime) {
      return candidate;
    }
    candidate += 2;
  }
};

/** Immutable string lookup stores only ids; spelling text has one owner. */
class StringIds {
  private readonly strings;
  private readonly slots;
  constructor(strings: IndexedStrings, slots: NumberColumn) {
    this.strings = strings;
    this.slots = slots;
  }
  get(key: string): number | undefined {
    let position = stringHash(key, this.slots.length);
    for (;;) {
      const stored = this.slots.get(position);
      if (stored === 0) {
        return undefined;
      }
      const id = stored - 1;
      if (this.strings.get(id) === key) {
        return id;
      }
      position = (position + 1) % this.slots.length;
    }
  }
}

export function* stringIdsSteps(
  strings: IndexedStrings,
): Generator<void, StringIds, void> {
  const capacity = lookupCapacity(strings.length);
  const slots = new NumberColumn();
  for (let position = 0; position < capacity; position += 1) {
    slots.push(0);
    if (position % COLUMN_CHUNK_SIZE === 0) {
      yield;
    }
  }
  for (let id = 0; id < strings.length; id += 1) {
    let position = stringHash(strings.get(id), capacity);
    let probes = 0;
    while (slots.get(position) !== 0) {
      position = (position + 1) % capacity;
      probes += 1;
      if (probes % COLUMN_CHUNK_SIZE === 0) {
        yield;
      }
    }
    slots.set(position, id + 1);
    if (id % COLUMN_CHUNK_SIZE === 0) {
      yield;
    }
  }
  return new StringIds(strings, slots);
}

export const appendUnsigned = (bytes: NumberColumn, value: number): void => {
  let rest = value;
  while (rest >= 128) {
    bytes.push((rest % 128) + 128);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
};

type UnsignedReaderOptions = { bytes: NumberColumn; from: number; to: number };
export class UnsignedReader {
  private readonly bytes;
  private readonly to;
  offset;
  private chunk;
  private localOffset;
  constructor({ bytes, from, to }: UnsignedReaderOptions) {
    this.bytes = bytes;
    this.offset = from;
    this.to = to;
    this.localOffset = from & COLUMN_CHUNK_MASK;
    this.chunk = from === to ? new Uint8Array(0) : bytes.byteChunk(from);
  }
  get done(): boolean {
    return this.offset === this.to;
  }
  read(): number {
    let value = 0;
    let factor = 1;
    for (;;) {
      if (this.offset >= this.to) {
        return panic("Truncated unsigned column value");
      }
      if (this.localOffset === COLUMN_CHUNK_SIZE) {
        this.chunk = this.bytes.byteChunk(this.offset);
        this.localOffset = 0;
      }
      const byte =
        this.chunk[this.localOffset] ?? panic("Missing unsigned byte");
      this.localOffset += 1;
      this.offset += 1;
      value += (byte % 128) * factor;
      if (byte < 128) {
        return value;
      }
      factor *= 128;
    }
  }
}

class DeltaReader {
  private readonly bytes;
  private value = 0;
  constructor(bytes: UnsignedReader) {
    this.bytes = bytes;
  }
  read(): number | undefined {
    if (this.bytes.done) {
      return undefined;
    }
    this.value += this.bytes.read();
    return this.value;
  }
}

class DeltaIterator implements IterableIterator<number> {
  private readonly reader;
  constructor(reader: DeltaReader) {
    this.reader = reader;
  }
  [Symbol.iterator](): IterableIterator<number> {
    return this;
  }
  next(): IteratorResult<number, void> {
    const value = this.reader.read();
    return value === undefined ? { done: true, value } : { done: false, value };
  }
}

type PackedPostingsOptions = {
  offsets: NumberColumn;
  sizes: NumberColumn;
  values: NumberColumn;
};

export class PackedPostings {
  private readonly offsets;
  private readonly values;
  private readonly sizes;
  constructor({ offsets, sizes, values }: PackedPostingsOptions) {
    this.offsets = offsets;
    this.values = values;
    this.sizes = sizes;
  }

  size(id: number): number {
    return this.sizes.get(id);
  }

  reader(id: number): DeltaReader {
    return new DeltaReader(
      new UnsignedReader({
        bytes: this.values,
        from: this.offsets.get(id),
        to: this.offsets.get(id + 1),
      }),
    );
  }

  get(id: number): IterableIterator<number> {
    return new DeltaIterator(this.reader(id));
  }
}

/** Append-only linked postings preserve insertion order without per-key arrays. */
const NO_NODE = 0xff_ff_ff_ff;

export class PostingColumn {
  private readonly heads = new NumberColumn();
  private readonly tails = new NumberColumn();
  private readonly sizes = new NumberColumn();
  private readonly values = new NumberColumn();
  private readonly next = new NumberColumn();

  addList(): number {
    this.heads.push(NO_NODE);
    this.tails.push(NO_NODE);
    return this.sizes.push(0);
  }

  push(id: number, value: number): void {
    const node = this.values.push(value);
    this.next.push(NO_NODE);
    const tail = this.tails.get(id);
    if (tail === NO_NODE) {
      this.heads.set(id, node);
    } else {
      this.next.set(tail, node);
    }
    this.tails.set(id, node);
    this.sizes.set(id, this.sizes.get(id) + 1);
  }

  *compact(): Generator<void, PackedPostings, void> {
    const offsets = new NumberColumn();
    const values = new NumberColumn("byte");
    const sizes = new NumberColumn();
    let processed = 0;
    offsets.push(0);
    for (let id = 0; id < this.heads.length; id += 1) {
      let previous = 0;
      for (const value of this.get(id)) {
        if (value < previous) {
          panic("Unordered compact postings");
        }
        appendUnsigned(values, value - previous);
        previous = value;
        processed += 1;
        if (processed % COLUMN_CHUNK_SIZE === 0) {
          yield;
        }
      }
      sizes.push(this.sizes.get(id));
      offsets.push(values.length);
      if (id % COLUMN_CHUNK_SIZE === 0) {
        yield;
      }
    }
    return new PackedPostings({ offsets, sizes, values });
  }

  size(id: number): number {
    return this.sizes.get(id);
  }

  *get(id: number): Generator<number, void, void> {
    for (
      let node = this.heads.get(id);
      node !== NO_NODE;
      node = this.next.get(node)
    ) {
      yield this.values.get(node);
    }
  }
}
