import { panic } from "better-result";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { parseCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import {
  unwrapPackedMemberRead,
  withReadableCorpusMember,
} from "@/api/lib/legal-search/corpus-storage";
import type { SizedCorpusAst } from "@/api/lib/legal-search/corpus-storage";
import type { CorpusTombstoneReader } from "@/api/lib/legal-search/corpus-tombstones";
import { deepFreeze } from "@/api/lib/legal-search/deep-freeze";
import type { EmptyAst } from "@/api/lib/legal-search/document-types";
import { recordReadWork } from "@/api/lib/observability/request-work";

/**
 * Heap bytes one character of decoded AST JSON costs once parsed. Measured on
 * a consolidation of a large civil code: 3.6 M characters of JSON parse to
 * about 10.4 MiB of live objects.
 */
const HEAP_BYTES_PER_DECODED_CHAR = 3;

type CachedAst = DocumentAst | EmptyAst | null;

type CorpusAstCacheOptions = {
  /** Ceiling on the estimated heap the cached ASTs hold together. */
  maxHeapBytes: number;
  read: (
    storedKey: string,
    readTombstones?: CorpusTombstoneReader,
  ) => Promise<SizedCorpusAst>;
};

export type CorpusAstCache = {
  read: (
    storedKey: string,
    readTombstones?: CorpusTombstoneReader,
  ) => Promise<CachedAst>;
  /** Estimated heap held. Exposed for the bound's tests. */
  heapBytes: () => number;
};

/**
 * Parsed corpus ASTs, kept across requests in least-recently-used order.
 *
 * A provision read needs a few hundred bytes of a consolidation, but the
 * payload is one zstd object, so every read decodes, parses and validates the
 * whole statute. A reader hovering citations or paging a provision's history
 * asks for the same consolidations again and again; this answers the repeats
 * from the parsed value and lets concurrent readers of one key share a single
 * read.
 *
 * Keys name immutable payloads. Erasing a standalone object deletes it and
 * the row that points at it; every caller gates the live row before reading.
 * Packed members are retained only when the caller supplies the denial reader
 * that revalidates erasure on every access, including cache hits. Without that
 * reader packed addresses pass through storage each time.
 *
 * Values are frozen: they are shared between requests, and a caller that
 * mutated one would change what every later reader sees.
 */
export const createCorpusAstCache = ({
  maxHeapBytes,
  read,
}: CorpusAstCacheOptions): CorpusAstCache => {
  const entries = new Map<string, { ast: CachedAst; heapBytes: number }>();
  const inFlight = new Map<string, Promise<CachedAst>>();
  let heldBytes = 0;

  const admit = (storedKey: string, { ast, decodedLength }: SizedCorpusAst) => {
    const heapBytes = decodedLength * HEAP_BYTES_PER_DECODED_CHAR;
    // One payload past the whole budget would evict everything and still not
    // fit, so it is served without being kept.
    if (heapBytes > maxHeapBytes) {
      return;
    }
    entries.set(storedKey, { ast, heapBytes });
    heldBytes += heapBytes;
    for (const [key, entry] of entries) {
      if (heldBytes <= maxHeapBytes) {
        break;
      }
      entries.delete(key);
      heldBytes -= entry.heapBytes;
    }
  };

  const load = async (
    storedKey: string,
    readTombstones?: CorpusTombstoneReader,
  ): Promise<CachedAst> => {
    const sized = await read(storedKey, readTombstones);
    const ast = deepFreeze(sized.ast);
    admit(storedKey, { ast, decodedLength: sized.decodedLength });
    return ast;
  };

  const readThrough = async (
    storedKey: string,
    readTombstones?: CorpusTombstoneReader,
  ): Promise<CachedAst> => {
    const hit = entries.get(storedKey);
    if (hit !== undefined) {
      recordReadWork("cacheHits");
      // Re-inserted so the map's insertion order stays recency order.
      entries.delete(storedKey);
      entries.set(storedKey, hit);
      return hit.ast;
    }
    const pending = inFlight.get(storedKey);
    if (pending !== undefined) {
      recordReadWork("cacheHits");
      return await pending;
    }
    // A failed read is not kept, so the next request retries it.
    const loading = load(storedKey, readTombstones).finally(() => {
      inFlight.delete(storedKey);
    });
    inFlight.set(storedKey, loading);
    return await loading;
  };

  return {
    read: async (storedKey, readTombstones) => {
      const location = parseCorpusLocation(storedKey);
      switch (location.type) {
        case "object":
          return await readThrough(storedKey, readTombstones);
        case "packed": {
          // A caller that can revalidate erasure on every read may reuse the
          // immutable payload. Readers without that gate still read through.
          if (readTombstones === undefined) {
            return (await read(storedKey)).ast;
          }
          const admitted = await withReadableCorpusMember({
            location,
            readTombstones,
            read: async () => await readThrough(storedKey, readTombstones),
          });
          return unwrapPackedMemberRead(admitted);
        }
        default: {
          location satisfies never;
          return panic(`Unhandled corpus location: ${String(location)}`);
        }
      }
    },
    heapBytes: () => heldBytes,
  };
};
