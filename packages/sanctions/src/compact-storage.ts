import { panic } from "better-result";

// Fixed-size allocations avoid copying a growing column on the serving loop.
const COLUMN_CHUNK_SIZE = 4096;
const MAP_SHARDS = 256;
const MAP_CHUNK_SIZE = 4096;

export class NumberColumn {
  private readonly chunks: (Uint32Array | Float64Array)[] = [];
  private readonly kind;
  constructor(kind: "integer" | "float" = "integer") {
    this.kind = kind;
  }
  length = 0;

  push(value: number): number {
    const index = this.length;
    if (index % COLUMN_CHUNK_SIZE === 0) {
      this.chunks.push(
        this.kind === "float"
          ? new Float64Array(COLUMN_CHUNK_SIZE)
          : new Uint32Array(COLUMN_CHUNK_SIZE),
      );
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
      this.chunks[Math.floor(index / COLUMN_CHUNK_SIZE)]?.[
        index % COLUMN_CHUNK_SIZE
      ] ?? panic("Missing compact column chunk")
    );
  }

  set(index: number, value: number): void {
    const chunk =
      this.chunks[Math.floor(index / COLUMN_CHUNK_SIZE)] ??
      panic("Missing compact column chunk");
    chunk[index % COLUMN_CHUNK_SIZE] = value;
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
      this.chunks[Math.floor(index / COLUMN_CHUNK_SIZE)]?.[
        index % COLUMN_CHUNK_SIZE
      ];
    return value === undefined ? panic("Missing compact object value") : value;
  }
}

/** Each engine Map is capped, including adversarial hash collisions. */
export class StringMap<T> {
  private readonly shards = Array.from({ length: MAP_SHARDS }, () => [
    new Map<string, T>(),
  ]);

  private bucket(key: string): Map<string, T>[] {
    let hash = 0;
    for (const character of key) {
      hash =
        (hash * 31 +
          (character.codePointAt(0) ?? panic("Missing shard code point"))) %
        MAP_SHARDS;
    }
    return this.shards[hash] ?? panic("Missing compact map shard");
  }

  get(key: string): T | undefined {
    for (const map of this.bucket(key)) {
      const value = map.get(key);
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

type PackedPostingsOptions = { offsets: NumberColumn; values: NumberColumn };

export class PackedPostings {
  private readonly offsets;
  private readonly values;
  constructor({ offsets, values }: PackedPostingsOptions) {
    this.offsets = offsets;
    this.values = values;
  }

  size(id: number): number {
    return this.offsets.get(id + 1) - this.offsets.get(id);
  }

  *get(id: number): Generator<number, void, void> {
    for (
      let offset = this.offsets.get(id);
      offset < this.offsets.get(id + 1);
      offset += 1
    ) {
      yield this.values.get(offset);
    }
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
    const values = new NumberColumn();
    offsets.push(0);
    for (let id = 0; id < this.heads.length; id += 1) {
      for (const value of this.get(id)) {
        values.push(value);
        if (values.length % COLUMN_CHUNK_SIZE === 0) {
          yield;
        }
      }
      offsets.push(values.length);
      if (id % COLUMN_CHUNK_SIZE === 0) {
        yield;
      }
    }
    return new PackedPostings({ offsets, values });
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
