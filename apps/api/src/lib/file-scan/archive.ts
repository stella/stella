import { panic, Result } from "better-result";
/**
 * Archive entries are inflated and inspected completely before rules decide.
 *
 * Rule strings live in the contents of OOXML parts, so every entry is
 * streamed through its inflater and scanned in fixed windows. Consecutive
 * windows overlap by one byte less than the longest match the rule engine
 * reports, so every occurrence lies wholly inside some window. Memory stays
 * at one window per entry plus the collected evidence.
 *
 * Rules that combine several strings, possibly from different entries or an
 * entry name and another entry's content, are not evaluated per window.
 * Windows only collect pattern occurrences; once the archive is read, each
 * rule's own condition runs over the occurrences collected for it.
 *
 * An archive is refused only when it cannot be inspected: encrypted entries,
 * an unsupported compression method, a corrupt index or stream, an
 * exhausted time or evidence budget, or an inspection defect. The archive-index guard runs first and
 * stays the size limit.
 */
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

import type { Match, Scanner } from "@/api/lib/file-scan/scanner";
import type {
  PatternOccurrence,
  WindowedRuleSet,
} from "@/api/lib/file-scan/yara";
import { hasZipMagic, readZipIndex } from "@/api/lib/file-scan/zip";
import type { ZipEntry } from "@/api/lib/file-scan/zip";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { isRecord } from "@/api/lib/type-guards";

export type ArchiveInspectionBudget = {
  /** Bytes of entry content scanned per window. */
  windowBytes: number;
  /** Bytes of pattern occurrences kept for rule evaluation. */
  maxEvidenceBytes: number;
  /** Wall-clock time for inspecting one archive. */
  timeBudgetMs: number;
};

const ARCHIVE_REFUSAL = {
  encrypted: {
    rule: "archive-encrypted",
    severity: "critical",
    meta: {
      description:
        "Archive entries are encrypted, so the file cannot be inspected",
    },
  },
  unsupportedCompression: {
    rule: "archive-compression-unsupported",
    severity: "critical",
    meta: {
      description:
        "Archive entries use an unsupported compression method, " +
        "so the file cannot be inspected",
    },
  },
  corrupt: {
    rule: "archive-corrupt",
    severity: "critical",
    meta: {
      description:
        "Archive structure is damaged, so the file cannot be inspected",
    },
  },
  failed: {
    rule: "archive-inspection-failed",
    severity: "critical",
    meta: {
      description: "Archive inspection failed, so the file cannot be inspected",
    },
  },
  budget: {
    rule: "archive-inspection-budget",
    severity: "critical",
    meta: {
      description:
        "Archive inspection did not finish within its limits, " +
        "so the file cannot be inspected",
    },
  },
} as const satisfies Record<string, Match>;

type Refusal = keyof typeof ARCHIVE_REFUSAL;

/** Rejecting findings an archive can carry; none can appear on accepted files. */
export const ARCHIVE_REFUSAL_RULES: readonly string[] = Object.values(
  ARCHIVE_REFUSAL,
).map(({ rule }) => rule);

const STORED = 0;
const DEFLATE = 8;
const AES = 99;
// Bit 0: encrypted. Bit 6: strong encryption.
const ENCRYPTION_FLAGS = [0x00_01, 0x00_40] as const;
// Small input slices bound the output a single inflate step can buffer.
const INFLATE_INPUT_BYTES = 4 * 1024;

// Evidence pieces are joined so no occurrence spans two of them: no pattern
// contains 0xff, and `>` ends every `[^>]` run. The leading pad places every
// piece past offset 64, where the embedded-signature rules look, and keeps
// anything from sitting at offset 0, which only a raw file can occupy.
const EVIDENCE_PAD = Buffer.alloc(64, 0xff);
const EVIDENCE_SEPARATOR = Buffer.from([0xff, 0x3e, 0xff]);

type Span = { stream: number; start: number; bytes: Buffer };

/**
 * Occurrences collected across every window. A rule decided by presence only
 * needs one occurrence per pattern; a counting rule keeps them all, keyed by
 * position so the overlap between windows does not count one twice.
 */
const createEvidence = (rules: WindowedRuleSet, maxBytes: number) => {
  const firstByPattern = new Map<string, Map<string, Buffer>>();
  const countedByPosition = new Map<string, Map<string, Span>>();
  let keptBytes = 0;

  const add = (
    stream: number,
    base: number,
    window: Uint8Array,
    { rule, pattern, offset, length }: PatternOccurrence,
  ): boolean => {
    const bytes = Buffer.from(window.subarray(offset, offset + length));
    if (rules.countingRules.has(rule)) {
      const spans = countedByPosition.get(rule) ?? new Map<string, Span>();
      countedByPosition.set(rule, spans);
      const start = base + offset;
      const key = `${stream}:${start}`;
      const kept = spans.get(key);
      if (kept !== undefined && kept.bytes.length >= length) {
        return true;
      }
      keptBytes += length - (kept?.bytes.length ?? 0);
      spans.set(key, { stream, start, bytes });
    } else {
      const patterns = firstByPattern.get(rule) ?? new Map<string, Buffer>();
      firstByPattern.set(rule, patterns);
      if (patterns.has(pattern)) {
        return true;
      }
      keptBytes += length;
      patterns.set(pattern, bytes);
    }
    return keptBytes <= maxBytes;
  };

  // Overlapping or touching occurrences are one contiguous run of the
  // original content, so they are rejoined rather than repeated.
  const mergedRuns = (spans: Iterable<Span>): Buffer[] => {
    const sorted = [...spans].toSorted(
      (a, b) => a.stream - b.stream || a.start - b.start,
    );
    const runs: { stream: number; end: number; parts: Buffer[] }[] = [];
    for (const span of sorted) {
      const run = runs.at(-1);
      const end = span.start + span.bytes.length;
      if (
        run !== undefined &&
        run.stream === span.stream &&
        span.start <= run.end
      ) {
        if (end > run.end) {
          run.parts.push(span.bytes.subarray(run.end - span.start));
          run.end = end;
        }
        continue;
      }
      runs.push({ stream: span.stream, end, parts: [span.bytes] });
    }
    return runs.map(({ parts }) => Buffer.concat(parts));
  };

  const evidenceFor = (rule: string): Buffer[] | null => {
    const counted = countedByPosition.get(rule);
    if (counted !== undefined) {
      return mergedRuns(counted.values());
    }
    const first = firstByPattern.get(rule);
    return first === undefined ? null : [...first.values()];
  };

  const evaluate = (): Match[] =>
    [
      ...new Set([...firstByPattern.keys(), ...countedByPosition.keys()]),
    ].flatMap((rule) => {
      const pieces = evidenceFor(rule);
      if (pieces === null) {
        return [];
      }
      const evidence = Buffer.concat([
        EVIDENCE_PAD,
        ...pieces.flatMap((piece) => [piece, EVIDENCE_SEPARATOR]),
      ]);
      const match = rules.evaluate(rule, evidence);
      return match === null ? [] : [match];
    });

  return { add, evaluate };
};

type Evidence = ReturnType<typeof createEvidence>;

type Inspection = { type: "inspected" } | { type: "refused"; refusal: Refusal };

const INSPECTED: Inspection = { type: "inspected" };
const refused = (refusal: Refusal): Inspection => ({
  type: "refused",
  refusal,
});

type ScanStreamOptions = {
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  stream: number;
  /** Bytes the entry index declares; the stream must produce exactly these. */
  declaredBytes: number;
  rules: WindowedRuleSet;
  evidence: Evidence;
  windowBytes: number;
  outOfTime: () => boolean;
};

/**
 * Scans a byte stream in windows of `windowBytes`, each starting
 * `windowBytes - overlap` after the previous one.
 */
const scanStream = async ({
  chunks,
  stream,
  declaredBytes,
  rules,
  evidence,
  windowBytes,
  outOfTime,
}: ScanStreamOptions): Promise<Inspection> => {
  const overlap = rules.maxMatchBytes - 1;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  // Leading bytes of `pending` an earlier window already scanned.
  let carriedBytes = 0;
  let base = 0;
  let produced = 0;

  const scanWindow = (window: Buffer): Inspection => {
    for (const occurrence of rules.occurrences(window)) {
      if (!evidence.add(stream, base, window, occurrence)) {
        return refused("budget");
      }
    }
    return outOfTime() ? refused("budget") : INSPECTED;
  };

  for await (const chunk of chunks) {
    produced += chunk.length;
    if (produced > declaredBytes) {
      return refused("corrupt");
    }
    pending.push(Buffer.from(chunk));
    pendingBytes += chunk.length;
    while (pendingBytes >= windowBytes) {
      const joined = Buffer.concat(pending);
      const scanned = scanWindow(joined.subarray(0, windowBytes));
      if (scanned.type === "refused") {
        return scanned;
      }
      const advance = windowBytes - overlap;
      pending = [joined.subarray(advance)];
      pendingBytes = joined.length - advance;
      carriedBytes = overlap;
      base += advance;
    }
  }
  if (produced !== declaredBytes) {
    return refused("corrupt");
  }
  return pendingBytes > carriedBytes
    ? scanWindow(Buffer.concat(pending))
    : INSPECTED;
};

async function* sliced(data: Uint8Array): AsyncGenerator<Buffer> {
  for (let at = 0; at < data.length; at += INFLATE_INPUT_BYTES) {
    yield Buffer.from(data.subarray(at, at + INFLATE_INPUT_BYTES));
  }
}

const entryContent = (entry: ZipEntry): AsyncIterable<Uint8Array> =>
  entry.method === STORED
    ? sliced(entry.data)
    : Readable.from(sliced(entry.data)).pipe(createInflateRaw());

// zlib reports damaged input with a `Z_*` code.
const isInflateError = (cause: unknown): boolean =>
  isRecord(cause) &&
  typeof cause["code"] === "string" &&
  cause["code"].startsWith("Z_");

const unreadableEntry = (entry: ZipEntry): Refusal | null => {
  // oxlint-disable-next-line no-bitwise -- ZIP flag check
  const flagged = ENCRYPTION_FLAGS.some((f) => (entry.flags & f) !== 0);
  if (entry.method === AES || flagged) {
    return "encrypted";
  }
  if (entry.method !== STORED && entry.method !== DEFLATE) {
    return "unsupportedCompression";
  }
  return null;
};

type InspectArchiveOptions = {
  bytes: Uint8Array;
  rules: WindowedRuleSet;
  budget: ArchiveInspectionBudget;
  now: () => number;
};

const inspectArchive = async ({
  bytes,
  rules,
  budget,
  now,
}: InspectArchiveOptions): Promise<Result<Match[], Refusal>> => {
  const zipIndex = readZipIndex(bytes);
  if (zipIndex.type === "malformed") {
    return Result.err("corrupt");
  }
  const { entries } = zipIndex;
  // Readers disagree on which of two same-named entries is "the" part, so
  // such an archive has no single content to vouch for.
  if (
    new Set(entries.map(({ name }) => name.toString("latin1"))).size !==
    entries.length
  ) {
    return Result.err("corrupt");
  }
  const unreadable = entries.map(unreadableEntry).find((r) => r !== null);
  if (unreadable !== undefined) {
    return Result.err(unreadable);
  }

  const deadline = now() + budget.timeBudgetMs;
  const outOfTime = () => now() > deadline;
  const evidence = createEvidence(rules, budget.maxEvidenceBytes);

  // Entries are read one at a time so memory holds one window at most.
  const inspectFrom = async (index: number): Promise<Inspection> => {
    const entry = entries[index];
    if (entry === undefined) {
      return INSPECTED;
    }
    const name = await scanStream({
      chunks: [entry.name],
      stream: 2 * index,
      declaredBytes: entry.name.length,
      rules,
      evidence,
      windowBytes: budget.windowBytes,
      outOfTime,
    });
    if (name.type === "refused") {
      return name;
    }
    const content = await scanStream({
      chunks: entryContent(entry),
      stream: 2 * index + 1,
      declaredBytes: entry.uncompressedSize,
      rules,
      evidence,
      windowBytes: budget.windowBytes,
      outOfTime,
    });
    return content.type === "refused" ? content : await inspectFrom(index + 1);
  };

  const inspection = await inspectFrom(0);
  return inspection.type === "refused"
    ? Result.err(inspection.refusal)
    : Result.ok(evidence.evaluate());
};

const INSPECTION_FAILURE_SINK = failureSink({
  event: "file_scan.archive_inspection_failed",
  expected: [],
});

type ArchiveContentScannerOptions = {
  rules: WindowedRuleSet;
  budget: ArchiveInspectionBudget;
  /** The archive-index guard. It reads entry count and declared sizes from
   *  the index alone, so it settles whether the archive is worth inflating
   *  before any entry is read. */
  guard: Scanner;
  now?: () => number;
};

export const createArchiveContentScanner = ({
  rules,
  budget,
  guard,
  now = performance.now.bind(performance),
}: ArchiveContentScannerOptions): Scanner => {
  if (budget.windowBytes < rules.maxMatchBytes) {
    panic("An archive window must hold the longest rule match");
  }
  return {
    async scan(bytes) {
      if (!hasZipMagic(bytes)) {
        return [];
      }

      // An archive the guard reports is already answered by that finding.
      const guardMatches = await guard.scan(bytes);
      if (guardMatches.length > 0) {
        return guardMatches;
      }

      const inspected = await Result.tryPromise({
        try: async () => await inspectArchive({ bytes, rules, budget, now }),
        catch: (cause) => cause,
      });
      if (Result.isOk(inspected)) {
        return Result.isError(inspected.value)
          ? [ARCHIVE_REFUSAL[inspected.value.error]]
          : inspected.value.value;
      }
      // A damaged deflate stream is a property of the file. Anything else is
      // a defect: it is reported, and the file is still refused rather than
      // left to a retry that would fail the same way.
      if (isInflateError(inspected.error)) {
        return [ARCHIVE_REFUSAL.corrupt];
      }
      observeFailure(inspected.error, {
        sink: INSPECTION_FAILURE_SINK,
        ctx: { feature: "file_scan.archive_inspection" },
      });
      return [ARCHIVE_REFUSAL.failed];
    },
  };
};
