import type { DocumentAst } from "@stll/legal-ast/document-ast";

import {
  readCorpusAst as readAstWithDenial,
  readCorpusSections as readSectionsWithDenial,
  readCorpusText as readTextWithDenial,
  readSizedCorpusAst as readSizedAstWithDenial,
} from "@/api/lib/legal-search/corpus-storage";
import type {
  CorpusByteSourceSeams,
  SizedCorpusAst,
} from "@/api/lib/legal-search/corpus-storage";
import {
  packedAddresses,
  selectCorpusTombstones,
} from "@/api/lib/legal-search/corpus-tombstones";
import type { CorpusTombstoneReader } from "@/api/lib/legal-search/corpus-tombstones";
import type {
  DecisionSection,
  EmptyAst,
} from "@/api/lib/legal-search/document-types";
import { publicLawReadDb } from "@/api/lib/public-law-read-db";

/**
 * The corpus payload readers, bound to this deployment's denial list.
 *
 * `corpus-storage.ts` takes the denial reader as an argument and holds no
 * database handle of its own, so a planner, a payload helper or an operator
 * script running on a login of its own can import the byte layer without
 * reaching the application's database. This module is the one place that
 * binds the two, and it is what a caller with no transaction of its own
 * reads through. A caller already inside one passes
 * `corpusTombstoneReaderForTx` and keeps its read to a single connection.
 */

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
  return await publicLawReadDb(
    async (tx) => await selectCorpusTombstones(tx, packed),
  );
};

/** The seams a caller may still replace; the denial reader is bound here. */
type BoundReadOptions = Omit<CorpusByteSourceSeams, "readTombstones">;

export const readCorpusText = async (
  storedKey: string,
  options: BoundReadOptions & { timeoutMs?: number } = {},
): Promise<string> =>
  await readTextWithDenial(storedKey, {
    readTombstones: readCorpusTombstones,
    ...options,
  });

export const readCorpusSections = async (
  storedKey: string,
  options: BoundReadOptions = {},
): Promise<DecisionSection[] | null> =>
  await readSectionsWithDenial(storedKey, {
    readTombstones: readCorpusTombstones,
    ...options,
  });

export const readCorpusAst = async (
  storedKey: string,
  options: BoundReadOptions = {},
): Promise<DocumentAst | EmptyAst | null> =>
  await readAstWithDenial(storedKey, {
    readTombstones: readCorpusTombstones,
    ...options,
  });

export const readSizedCorpusAst = async (
  storedKey: string,
  options: BoundReadOptions = {},
): Promise<SizedCorpusAst> =>
  await readSizedAstWithDenial(storedKey, {
    readTombstones: readCorpusTombstones,
    ...options,
  });
