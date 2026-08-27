/**
 * Archive entries are inflated before rule evaluation.
 *
 * Rule strings live in the contents of OOXML parts, so entries are inflated
 * first. Entry paths and inflated contents are flattened into a single buffer
 * so rules that combine a part name with part content keep evaluating against
 * one byte range, exactly as they do for a stored archive.
 *
 * Inflation is best effort and bounded: an entry that would exceed the budget
 * is skipped and the shortfall is reported rather than failing the scan.
 */
import JSZip from "jszip";

import type { Match, Scanner } from "@/api/lib/file-scan/scanner";
import { hasZipMagic } from "@/api/lib/file-scan/zip";

export type ArchiveInflateBudget = {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
};

type InflatedArchive =
  | { coverage: "complete"; bytes: Uint8Array }
  | { coverage: "partial"; bytes: Uint8Array }
  | { coverage: "unreadable" };

const SEPARATOR = Buffer.from("\n");

const inflateEntry = async (
  entry: JSZip.JSZipObject,
  limit: number,
): Promise<Buffer | null> =>
  await new Promise<Buffer | null>((resolve) => {
    const stream = entry.nodeStream("nodebuffer");
    const chunks: Buffer[] = [];
    let read = 0;
    let stopped = false;

    const abort = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      // `destroy` exists on Node Readables; JSZip returns one but types it
      // as the parent NodeJS.ReadableStream interface.
      const destroy: unknown = Reflect.get(stream, "destroy");
      if (typeof destroy === "function") {
        Reflect.apply(destroy, stream, []);
      }
      resolve(null);
    };

    stream.on("data", (chunk: Buffer | string) => {
      if (stopped) {
        return;
      }
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      read += piece.length;
      if (read > limit) {
        abort();
        return;
      }
      chunks.push(piece);
    });
    stream.on("end", () => {
      if (!stopped) {
        stopped = true;
        resolve(Buffer.concat(chunks));
      }
    });
    stream.on("error", abort);
  });

const inflateArchive = async (
  bytes: Uint8Array,
  budget: ArchiveInflateBudget,
): Promise<InflatedArchive> => {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { coverage: "unreadable" };
  }

  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const parts: Buffer[] = [];
  let remaining = budget.maxTotalBytes;
  let skipped = entries.length > budget.maxEntries;

  for (const entry of entries.slice(0, budget.maxEntries)) {
    parts.push(Buffer.from(entry.name, "utf-8"), SEPARATOR);
    // oxlint-disable-next-line no-await-in-loop -- entries inflate one at a time so the remaining byte budget is exact
    const content = await inflateEntry(
      entry,
      Math.min(budget.maxEntryBytes, remaining),
    );
    if (content === null) {
      skipped = true;
      continue;
    }
    remaining -= content.length;
    parts.push(content, SEPARATOR);
  }

  const flattened = Buffer.concat(parts);
  return skipped
    ? { coverage: "partial", bytes: flattened }
    : { coverage: "complete", bytes: flattened };
};

/**
 * Reported so a shortfall in rule coverage is visible in the scan record
 * rather than being indistinguishable from a clean archive.
 */
const ARCHIVE_PARTIAL: Match = {
  rule: "archive-scan-partial",
  severity: "info",
  meta: {
    description:
      "Some archive entries exceeded the inflation budget; " +
      "rules were evaluated against part of the archive only",
  },
};

const ARCHIVE_UNREADABLE: Match = {
  rule: "archive-unreadable",
  severity: "info",
  meta: {
    description:
      "Archive index could not be read; " +
      "rules were evaluated against the raw bytes only",
  },
};

export const createArchiveContentScanner = (
  inner: Scanner,
  budget: ArchiveInflateBudget,
): Scanner => ({
  async scan(bytes) {
    if (!hasZipMagic(bytes)) {
      return [];
    }

    const inflated = await inflateArchive(bytes, budget);
    switch (inflated.coverage) {
      case "unreadable":
        return [ARCHIVE_UNREADABLE];
      case "partial": {
        const matches = await inner.scan(inflated.bytes);
        matches.push(ARCHIVE_PARTIAL);
        return matches;
      }
      case "complete":
        return await inner.scan(inflated.bytes);
      default:
        return inflated satisfies never;
    }
  },
});
