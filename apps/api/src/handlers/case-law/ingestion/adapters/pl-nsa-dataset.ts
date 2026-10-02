/**
 * The Hugging Face dataset `JuDDGES/pl-nsa`, pinned to one revision, and the
 * reader that walks it.
 *
 * The dataset is 46 parquet shards of Polish administrative-court decisions.
 * Every shard is one row group, written without a page index, so a slice of
 * rows cannot be read without the whole column chunk it sits in. A shard is
 * therefore downloaded once, checked against the digest the repository
 * publishes for it, and read locally a window of rows at a time; only one
 * shard is kept on disk.
 *
 * The revision is pinned rather than followed: a revision is an immutable
 * snapshot, so a position `(shard, row)` inside it names one decision for
 * good, which is what makes the cursor resumable (rule 19). Moving to a newer
 * revision is a deliberate change to {@link PL_NSA_SNAPSHOT}, not something
 * the crawl discovers.
 */

import { panic, Result } from "better-result";
import type { AsyncBuffer, FileMetaData } from "hyparquet";
import {
  parquetMetadataAsync,
  parquetReadObjects,
  parquetSchema,
} from "hyparquet";
import { appendFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { readCappedBytes } from "@stll/skills/streaming";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

// ── The pinned snapshot ──────────────────────────────────

export type PlNsaShard = {
  /** Position of the shard in walk order; also its file's number. */
  readonly index: number;
  /** Path inside the dataset repository. */
  readonly path: string;
  readonly bytes: number;
  /** SHA-256 of the file, as the repository states it for the revision. */
  readonly sha256: string;
  /** Rows the shard's own footer states. */
  readonly rows: number;
};

export type PlNsaSnapshot = {
  readonly repository: string;
  /** The dataset commit every shard below belongs to. */
  readonly revision: string;
  /**
   * The day the dataset's content was taken, as its card states it ("the
   * last update on 2025-03-06"). Every time-varying fact a row carries —
   * finality above all — is true as of this day, not as of the import.
   */
  readonly snapshotDate: string;
  readonly shards: readonly PlNsaShard[];
};

const shard = (
  index: number,
  bytes: number,
  sha256: string,
  rows: number,
): PlNsaShard => ({
  index,
  path: `data/data_${index}.parquet`,
  bytes,
  sha256,
  rows,
});

export const PL_NSA_SNAPSHOT: PlNsaSnapshot = {
  repository: "JuDDGES/pl-nsa",
  revision: "595f2301210eb513c392b437153aa2c5f6683240",
  snapshotDate: "2025-03-06",
  shards: [
    shard(
      0,
      684_463_419,
      "88f22687cd83f5efaed9f738936b0e5e44c7569e6fb4ca5d7b75c4d9d0d97347",
      50_000,
    ),
    shard(
      1,
      689_367_601,
      "4b2e1b6579fc8b358af1ddd4310a9e07f15e3a1ee5fe7bac01c83d70982dd3e9",
      50_000,
    ),
    shard(
      2,
      681_958_636,
      "a409b5d9332333ca0bb638b5e1522f8ba5ae25d4371d67185b5eef485ac3a5d8",
      50_000,
    ),
    shard(
      3,
      685_022_384,
      "5d0d814fc8fbeb70290db4ed4ea34432e0467dbae3b1ef7c59a5252ebdd8d8ee",
      50_000,
    ),
    shard(
      4,
      689_491_658,
      "fc1286dadd102be9751ed8740032cd1a5f99c0f658f8af22993a5f62e891c677",
      50_000,
    ),
    shard(
      5,
      685_503_047,
      "0624e0b0537b9f8a52b17f30a1bee83f4bdcc54c28ac47a8c66c7ea37267caef",
      50_000,
    ),
    shard(
      6,
      690_006_871,
      "884184fbc09ff9240fda9ee4025f1eb1c3a582929b9c7ba39ed8995535eee4b8",
      50_000,
    ),
    shard(
      7,
      684_411_581,
      "c71303f20035a9322ef5315aade8e8f95d9cd28c9e9c26409777ec65b6c3ede7",
      50_000,
    ),
    shard(
      8,
      686_556_939,
      "3605b7c63607b2eb45a961a2638d027c78e5414f986340deb32ee9d4d83e6c92",
      50_000,
    ),
    shard(
      9,
      695_218_931,
      "2452d82d6f516eaa377dd63bf6e4c4b16cd7b274228c78455993f2cba70a254a",
      50_000,
    ),
    shard(
      10,
      685_657_015,
      "6ac9a3a9c11e63935b28be326a343a0ac149b982cb096654c6eddd06e6d313d2",
      50_000,
    ),
    shard(
      11,
      689_098_390,
      "5a0318f149d109396ecf3869a170073ec4269be0cc4dff566cb388759f41e06b",
      50_000,
    ),
    shard(
      12,
      689_585_090,
      "1aae78df49b8cb789d2ec2816c76f1dc9babb4b726d5b15b7788a9e7128001f8",
      50_000,
    ),
    shard(
      13,
      683_569_533,
      "0f5d90c24ae11535eee227739bfc61e9a2f0ed02e9e72471e32a257a2088b3f5",
      50_000,
    ),
    shard(
      14,
      687_048_206,
      "810692e0340d2d1a33d683de7a4c50f29f2f525bbec409d1ab4ef14fa1d590ca",
      50_000,
    ),
    shard(
      15,
      687_226_292,
      "16eca46fc0d2de72bfd21a0ec203a5945ec9cce1c382296b703b1f3030a667cf",
      50_000,
    ),
    shard(
      16,
      687_520_013,
      "cf9946c0d654a8599dac18e761195f551316c802ca2ddbbf58f1a3c6b645af37",
      50_000,
    ),
    shard(
      17,
      688_201_517,
      "d9be7277045582b984e3f0aab656ad39588e8aa957d9587f65eebfd924bd34a0",
      50_000,
    ),
    shard(
      18,
      685_321_381,
      "d530c437507ba0c44f5c4ef9f9253099a218e71f5dd712d0d4ba214ccc5d759b",
      50_000,
    ),
    shard(
      19,
      692_312_618,
      "c553094f08c5f3c5017ad46ccc5788a41396196657b458d8ff8cffa58976ac89",
      50_000,
    ),
    shard(
      20,
      687_854_974,
      "8b6b67be8c80a6c0a186f6d9e2079781c51f4bc5eaca49d7aabd8c66ddacd4b8",
      50_000,
    ),
    shard(
      21,
      679_950_657,
      "21553eb68364cc62c939a8b3deb76b1f59fab497b165d80648472206d9f73a5c",
      50_000,
    ),
    shard(
      22,
      688_219_089,
      "6e030327ed4a0f4465feebf500ab9b04249f225d48373a6fb44c65dbb5beefbc",
      50_000,
    ),
    shard(
      23,
      686_278_816,
      "d5ab4f7a64ad7c7b0a9d037496de19acc4e4b2facb82ae8b11728dd2583ec1ec",
      50_000,
    ),
    shard(
      24,
      688_004_671,
      "a7e105ee78692fc9cdef0471adb9d17f8f7c2ca5b05172c0811fa597209d00aa",
      50_000,
    ),
    shard(
      25,
      682_625_563,
      "cadc0a6c35ef822b6251a5dc9e4885f6ab8aec23844b6c4ad60410a4541e1dbe",
      50_000,
    ),
    shard(
      26,
      691_043_208,
      "39eaebadee92af3249de8ff1319e9525dc054982d6028bd15c0562a34c6d83b9",
      50_000,
    ),
    shard(
      27,
      691_637_222,
      "d2bf48ef65d3dc0601075296d93b520cc890353a35d959885f419b7758ed1237",
      50_000,
    ),
    shard(
      28,
      686_451_307,
      "f09afe0c948e05f4b24bfac8c6bc46db07167a176d16febaac7d1e8937852833",
      50_000,
    ),
    shard(
      29,
      686_621_838,
      "7f0be357d12fb2ce54f37859243db89ae87bf5b898232076a15d00deb63b98bc",
      50_000,
    ),
    shard(
      30,
      684_792_493,
      "f3d918244ca73553d75ab5b683871e9c9e335c789fc4084d2bd59c99bfa66657",
      50_000,
    ),
    shard(
      31,
      685_680_485,
      "533da46189ccc44905f257a765acc67518da83e0d123f4d38129f15e65d19eb5",
      50_000,
    ),
    shard(
      32,
      689_908_943,
      "86f72570968a0004bb75721fea2ecf94183fc5b8925f61751d32fb082e35f86d",
      50_000,
    ),
    shard(
      33,
      684_764_917,
      "c7cd1ce68e2dd8031dcf11fd0bd7bcbafff26c95c0659d3ed53ef098198f51e2",
      50_000,
    ),
    shard(
      34,
      691_143_651,
      "38c7c5e0d561a985714cd6ee2af49a6f809d84d91e1ef9fa36aa594c37cb8f1e",
      50_000,
    ),
    shard(
      35,
      683_183_026,
      "11b02329008ab17d544cab9477b78215fa11a9f785d5e85963859734b2430f16",
      50_000,
    ),
    shard(
      36,
      684_252_045,
      "86ff00ab158a999c117701a5b6ecaa356a81b8003f4195ee689d69665cd67607",
      50_000,
    ),
    shard(
      37,
      687_781_616,
      "7c8f8428d40b027522a73b29502ab4551b3c17ca6045a63b829f02bff6a092ab",
      50_000,
    ),
    shard(
      38,
      689_247_596,
      "a101743148ef153739b46f2ee38b25044976e6b3254a4b36efdc9712c991b4a8",
      50_000,
    ),
    shard(
      39,
      711_860_302,
      "8db0d027b58bbe935443cecc64516bc67779e7c2782b93694669f834ad5be404",
      50_000,
    ),
    shard(
      40,
      756_447_487,
      "0bc4a16f96c25c96c2cd06aac85f6ea4df832655cde370a0701f28f0f0bbc69b",
      50_000,
    ),
    shard(
      41,
      756_656_104,
      "087fbea0f2b85a6bd5e17653259ec33e7a0b6f2e162bd12cf697c1678481c6ec",
      50_000,
    ),
    shard(
      42,
      753_767_805,
      "877819d2609c65697e5d961fea17982e356f98fd4219d7e9d1f96e2a067f734a",
      50_000,
    ),
    shard(
      43,
      763_513_401,
      "3825a1402e63658e8c3001a82c392b3f2881e00ac82cb959021cc5cd088827a6",
      50_000,
    ),
    shard(
      44,
      755_463_782,
      "eb776072f12ae5cae710550b9255a23849dffa5c97b9312d5e9393336f86bb22",
      50_000,
    ),
    shard(
      45,
      52_056_126,
      "0c597b2bb5860bbf933cef8a4b251f6ca55310a86f582067063d05cf15d8ee10",
      4392,
    ),
  ],
};

/** Every row the pinned revision holds, summed over its shards' footers. */
export const plNsaSnapshotRows = (snapshot: PlNsaSnapshot): number =>
  snapshot.shards.reduce((total, { rows }) => total + rows, 0);

/** The repository's own origin; every shard address starts here. */
const HUGGING_FACE_ORIGIN = "https://huggingface.co";

export const plNsaShardUrl = (
  snapshot: PlNsaSnapshot,
  { path }: PlNsaShard,
): string =>
  `${HUGGING_FACE_ORIGIN}/datasets/${snapshot.repository}/resolve/${snapshot.revision}/${path}`;

// ── Failures ─────────────────────────────────────────────

/**
 * Whether asking again can help. A transient failure — a timeout, a server
 * error, a rate limit, a short read — fails the page so the cursor is retried
 * (rule 20). A permanent one — the pinned file gone, bytes that do not hash
 * to the revision's digest, a footer that disagrees with the pinned row count
 * — cannot clear by retrying, so it is remembered and answered again without
 * another request: repeating it would re-download the shard every cycle.
 */
const PL_NSA_FAILURE = {
  TRANSIENT: "transient",
  PERMANENT: "permanent",
} as const;

type PlNsaFailure = (typeof PL_NSA_FAILURE)[keyof typeof PL_NSA_FAILURE];

/** Statuses that say the pinned file is not there to be read. */
const PERMANENT_STATUSES = new Set([401, 403, 404, 410]);

const failureOfStatus = (status: number): PlNsaFailure =>
  PERMANENT_STATUSES.has(status)
    ? PL_NSA_FAILURE.PERMANENT
    : PL_NSA_FAILURE.TRANSIENT;

const failurePrefix = (failure: PlNsaFailure): string =>
  `pl-nsa dataset (${failure}): `;

const plNsaDatasetError = (
  failure: PlNsaFailure,
  message: string,
  httpStatus?: number,
): AdapterFetchError =>
  new AdapterFetchError({
    message: `${failurePrefix(failure)}${message}`,
    adapterKey: ADAPTER_KEYS.PL_NSA,
    cursor: null,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

/** Whether an error this module raised was a permanent one. */
export const isPermanentPlNsaError = (error: AdapterFetchError): boolean =>
  error.message.startsWith(failurePrefix(PL_NSA_FAILURE.PERMANENT));

type DatasetResult<T> = Result<T, AdapterFetchError>;

/**
 * An error the parquet reader surfaced. The reader calls back into the byte
 * source, so a failure of a ranged read reaches here as the rejection it was
 * raised as and keeps its classification; anything else is the reader's own
 * failure over bytes that verified, which asking again will not change.
 */
const readerFailure = (cause: unknown): AdapterFetchError =>
  cause instanceof AdapterFetchError
    ? cause
    : plNsaDatasetError(
        PL_NSA_FAILURE.PERMANENT,
        `the parquet reader failed: ${errorTag(cause)}`,
      );

// ── Reading rows ─────────────────────────────────────────

/**
 * The text columns, each read on its own: one of them spans hundreds of
 * megabytes in a shard, and reading them together would hold all of them in
 * memory at once.
 */
const TEXT_COLUMNS = new Set([
  "thesis",
  "sentence",
  "reasons_for_judgment",
  "dissenting_opinion",
  "full_text",
]);

/** A row as the shard states it, every top-level column present. */
export type PlNsaDatasetRow = Readonly<Record<string, unknown>>;

const topLevelColumns = (metadata: FileMetaData): string[] =>
  parquetSchema(metadata).children.map((child) => child.element.name);

type ReadRowsOptions = {
  file: AsyncBuffer;
  /** The rows the pinned manifest states the file holds. */
  expectedRows: number;
  rowStart: number;
  rowEnd: number;
};

/**
 * The file's own footer, held to the row count the pinned manifest states.
 * A file stating fewer rows would end the walk early with the rest never
 * read; one stating more would hide rows the cursor never reaches. Either is
 * not the file the revision pinned.
 */
const checkedMetadata = async (
  file: AsyncBuffer,
  expectedRows: number,
): Promise<DatasetResult<FileMetaData>> => {
  const read = await Result.tryPromise({
    try: async () => await parquetMetadataAsync(file),
    catch: readerFailure,
  });
  if (Result.isError(read)) {
    return read;
  }
  const stated = Number(read.value.num_rows);
  return stated === expectedRows
    ? read
    : Result.err(
        plNsaDatasetError(
          PL_NSA_FAILURE.PERMANENT,
          `the file states ${stated} rows, the pinned revision ${expectedRows}`,
        ),
      );
};

type ReadColumnsOptions = {
  file: AsyncBuffer;
  metadata: FileMetaData;
  columns: string[];
  rowStart: number;
  rowEnd: number;
};

/**
 * Rows of some columns, failing closed when the reader answers fewer or more
 * rows than were asked for: a short answer would otherwise read as rows that
 * are not there.
 */
const readColumns = async ({
  columns,
  file,
  metadata,
  rowEnd,
  rowStart,
}: ReadColumnsOptions): Promise<DatasetResult<Record<string, unknown>[]>> => {
  const read = await Result.tryPromise({
    try: async () =>
      await parquetReadObjects({ file, metadata, columns, rowStart, rowEnd }),
    catch: readerFailure,
  });
  if (Result.isError(read)) {
    return read;
  }
  return read.value.length === rowEnd - rowStart
    ? read
    : Result.err(
        plNsaDatasetError(
          PL_NSA_FAILURE.PERMANENT,
          `the reader answered ${read.value.length} rows where ${rowEnd - rowStart} were asked for`,
        ),
      );
};

/**
 * Rows `[rowStart, rowEnd)` of one shard, with every column the file states
 * — including any a later revision adds, which is how a column nobody has
 * decided about reaches the field inventory instead of being skipped.
 *
 * A null the reader leaves out of an object is written back as `null`, so
 * an absent value and an absent column cannot be confused.
 */
export const readPlNsaRows = async ({
  expectedRows,
  file,
  rowEnd,
  rowStart,
}: ReadRowsOptions): Promise<DatasetResult<PlNsaDatasetRow[]>> => {
  const checked = await checkedMetadata(file, expectedRows);
  if (Result.isError(checked)) {
    return checked;
  }
  const metadata = checked.value;
  const columns = topLevelColumns(metadata);
  const end = Math.min(rowEnd, expectedRows);
  if (rowStart >= end) {
    return Result.ok([]);
  }

  const groups = [
    columns.filter((column) => !TEXT_COLUMNS.has(column)),
    ...columns.filter((column) => TEXT_COLUMNS.has(column)).map((c) => [c]),
  ].filter((group) => group.length > 0);

  const rows: Record<string, unknown>[] = Array.from(
    { length: end - rowStart },
    () => Object.fromEntries(columns.map((column) => [column, null])),
  );
  for (const group of groups) {
    const read = await readColumns({
      file,
      metadata,
      columns: group,
      rowStart,
      rowEnd: end,
    });
    if (Result.isError(read)) {
      return read;
    }
    for (const [offset, values] of read.value.entries()) {
      const row = rows[offset] ?? panic("row window out of step");
      for (const column of group) {
        row[column] = values[column] ?? null;
      }
    }
  }
  return Result.ok(rows);
};

/** Columns a row can be told apart by when it states no publisher id. */
export const PL_NSA_FINGERPRINT_COLUMNS = [
  "docket_number",
  "judgment_type",
  "judgment_date",
  "submission_date",
  "court_name",
] as const;

type PlNsaListedRow = {
  judgmentId: string | null;
  /** The fingerprint columns, read only for a row with no id. */
  fingerprint: PlNsaDatasetRow | null;
};

/**
 * The publisher ids of rows `[rowStart, rowEnd)`, reading one small column,
 * and for a row without one, the small columns its quarantine identity is
 * built from.
 */
export const readPlNsaListing = async ({
  expectedRows,
  file,
  rowEnd,
  rowStart,
}: ReadRowsOptions): Promise<DatasetResult<PlNsaListedRow[]>> => {
  const checked = await checkedMetadata(file, expectedRows);
  if (Result.isError(checked)) {
    return checked;
  }
  const metadata = checked.value;
  const end = Math.min(rowEnd, expectedRows);
  if (rowStart >= end) {
    return Result.ok([]);
  }
  const read = await readColumns({
    file,
    metadata,
    columns: ["judgment_id"],
    rowStart,
    rowEnd: end,
  });
  if (Result.isError(read)) {
    return read;
  }
  const ids = read.value.map(({ judgment_id: id }) =>
    typeof id === "string" && id.length > 0 ? id : null,
  );
  if (!ids.includes(null)) {
    return Result.ok(
      ids.map((judgmentId) => ({ judgmentId, fingerprint: null })),
    );
  }
  const fingerprints = await readColumns({
    file,
    metadata,
    columns: [...PL_NSA_FINGERPRINT_COLUMNS],
    rowStart,
    rowEnd: end,
  });
  if (Result.isError(fingerprints)) {
    return fingerprints;
  }
  return Result.ok(
    ids.map((judgmentId, offset) => ({
      judgmentId,
      fingerprint:
        judgmentId === null
          ? Object.fromEntries(
              PL_NSA_FINGERPRINT_COLUMNS.map((column) => [
                column,
                fingerprints.value[offset]?.[column] ?? null,
              ]),
            )
          : null,
    })),
  );
};

// ── Where shard bytes come from ──────────────────────────

/**
 * How the adapter reaches a shard. Production downloads from the dataset
 * repository; tests hand in a recorded file.
 */
export type PlNsaShardSource = {
  /** The whole shard, local and verified, for reading rows. */
  readonly local: (
    shard: PlNsaShard,
    signal?: AbortSignal,
  ) => Promise<DatasetResult<AsyncBuffer>>;
  /** Ranged reads against the repository, for narrow columns. */
  readonly remote: (
    shard: PlNsaShard,
    signal?: AbortSignal,
  ) => Promise<DatasetResult<AsyncBuffer>>;
};

const fileBuffer = (path: string): AsyncBuffer => {
  const file = Bun.file(path);
  return {
    byteLength: file.size,
    slice: async (start, end) => await file.slice(start, end).arrayBuffer(),
  };
};

/** A recorded file standing in for every shard, for tests and replays. */
export const localFileShardSource = (path: string): PlNsaShardSource => ({
  local: async () => await Promise.resolve(Result.ok(fileBuffer(path))),
  remote: async () => await Promise.resolve(Result.ok(fileBuffer(path))),
});

/**
 * The repository answers a file request with a redirect to its CDN. Both
 * hosts belong to the publisher; anything else is refused before a request
 * leaves (rule 21).
 */
const HUGGING_FACE_HOST_POLICY = {
  type: "https-host-suffix",
  suffixes: ["huggingface.co", "hf.co"],
} as const;

/**
 * Bytes asked for per request. Large enough that a shard is about a dozen
 * requests, small enough that one fits a request timeout on a slow link.
 * Also the ceiling a response body is read up to.
 */
const DOWNLOAD_CHUNK_BYTES = 64 * 1024 * 1024;

const DOWNLOAD_CHUNK_TIMEOUT_MS = 10 * 60 * 1000;

const LOCATE_TIMEOUT_MS = 30_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const refusedAddress = (): AdapterFetchError =>
  plNsaDatasetError(
    PL_NSA_FAILURE.PERMANENT,
    "refused a file address outside the repository",
  );

/**
 * A request that never got an answer: a dropped connection, an exhausted
 * timeout budget. The publisher said nothing, so asking again may help.
 */
const requestFailure =
  (path: string) =>
  (cause: unknown): AdapterFetchError =>
    plNsaDatasetError(
      PL_NSA_FAILURE.TRANSIENT,
      `${path} could not be read: ${errorTag(cause)}`,
    );

type RangeRequest = {
  rawUrl: string;
  start: number;
  /** Inclusive, as the Range header states it. */
  end: number;
  path: string;
  signal?: AbortSignal | undefined;
};

/**
 * One ranged read of a file the repository serves, behind the publisher
 * gate, read up to exactly the bytes asked for. The address is checked here
 * rather than by callers, because the CDN address arrives in a redirect and
 * is not ours to trust, and no further redirect is followed.
 */
const readRepositoryRange = async ({
  end,
  path,
  rawUrl,
  signal,
  start,
}: RangeRequest): Promise<DatasetResult<Uint8Array>> => {
  const target = restrictOutboundUrl({
    hostPolicy: HUGGING_FACE_HOST_POLICY,
    rawUrl,
  });
  if (target === null) {
    return Result.err(refusedAddress());
  }
  const wanted = end - start + 1;
  const answered = await Result.tryPromise({
    try: async () => {
      const response = await fetchWithRetry(
        target.toString(),
        { headers: { Range: `bytes=${start}-${end}` }, redirect: "error" },
        {
          adapterKey: ADAPTER_KEYS.PL_NSA,
          signal,
          timeoutMs: DOWNLOAD_CHUNK_TIMEOUT_MS,
        },
      );
      if (response.status !== 206 || response.body === null) {
        await response.body?.cancel();
        return { status: response.status, bytes: null };
      }
      return {
        status: response.status,
        bytes: await readCappedBytes(response.body, wanted),
      };
    },
    catch: requestFailure(path),
  });
  if (Result.isError(answered)) {
    return answered;
  }
  const { bytes, status } = answered.value;
  if (status !== 206) {
    return Result.err(
      plNsaDatasetError(
        failureOfStatus(status),
        `${path} answered ${status} for bytes ${start}-${end}`,
        status,
      ),
    );
  }
  return bytes?.byteLength === wanted
    ? Result.ok(bytes)
    : Result.err(
        plNsaDatasetError(
          PL_NSA_FAILURE.TRANSIENT,
          `${path} served ${bytes === null ? "more" : bytes.byteLength} bytes for ${start}-${end}`,
        ),
      );
};

/**
 * Where the repository serves a shard's bytes from today. The repository
 * answers with a redirect to its CDN; the redirect is read rather than
 * followed, and its target is held to the same host policy before any read.
 */
const locateShard = async (
  snapshot: PlNsaSnapshot,
  target: PlNsaShard,
  signal?: AbortSignal,
): Promise<DatasetResult<string>> => {
  // Addressed on the repository's fixed origin, so the destination is known
  // statically; the redirect is read rather than followed, and its target is
  // held to the host policy before readRepositoryRange requests it.
  const url = plNsaShardUrl(snapshot, target);
  const answered = await Result.tryPromise({
    try: async () => {
      const response = await fetchWithRetry(
        `${HUGGING_FACE_ORIGIN}/datasets/${snapshot.repository}/resolve/${snapshot.revision}/${target.path}`,
        { method: "HEAD", redirect: "manual" },
        {
          adapterKey: ADAPTER_KEYS.PL_NSA,
          signal,
          timeoutMs: LOCATE_TIMEOUT_MS,
        },
      );
      await response.body?.cancel();
      return {
        ok: response.ok,
        status: response.status,
        location: response.headers.get("location"),
      };
    },
    catch: requestFailure(target.path),
  });
  if (Result.isError(answered)) {
    return answered;
  }
  const { location, ok, status } = answered.value;
  if (ok) {
    return Result.ok(url);
  }
  if (!REDIRECT_STATUSES.has(status) || location === null) {
    return Result.err(
      plNsaDatasetError(
        failureOfStatus(status),
        `${target.path} answered ${status}`,
        status,
      ),
    );
  }
  const redirected = restrictOutboundUrl({
    hostPolicy: HUGGING_FACE_HOST_POLICY,
    rawUrl: new URL(location, url).toString(),
  });
  return redirected === null
    ? Result.err(refusedAddress())
    : Result.ok(redirected.toString());
};

const hashFile = async (
  path: string,
  hasher: Bun.CryptoHasher,
): Promise<void> => {
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }
};

/** The size of a regular file, or `null` where there is none. */
const sizeOf = async (path: string): Promise<number | null> => {
  const file = Bun.file(path);
  return (await file.exists()) ? file.size : null;
};

/** Statuses a signed CDN address answers once its signature has expired. */
const EXPIRED_SIGNATURE_STATUSES = new Set([401, 403]);

type ShardReader = {
  read: (start: number, end: number) => Promise<DatasetResult<Uint8Array>>;
};

/**
 * Ranged reads of one shard through the address the repository redirects
 * to. That address is a signed CDN URL that expires; a download of a large
 * shard, or a remote buffer kept across pages, can outlive it. A refusal of
 * the signature is therefore answered by asking the repository for a fresh
 * address and reading again, once: only a refusal of an address issued just
 * now says the file itself is refused.
 */
const shardReader = (
  snapshot: PlNsaSnapshot,
  target: PlNsaShard,
  signal?: AbortSignal,
): ShardReader => {
  let location: string | null = null;

  const locate = async (): Promise<DatasetResult<string>> => {
    const located = await locateShard(snapshot, target, signal);
    if (Result.isOk(located)) {
      location = located.value;
    }
    return located;
  };

  const readFrom = async (
    rawUrl: string,
    start: number,
    end: number,
  ): Promise<DatasetResult<Uint8Array>> =>
    await readRepositoryRange({
      rawUrl,
      start,
      end,
      path: target.path,
      signal,
    });

  return {
    read: async (start, end) => {
      const known = location;
      const first = known === null ? await locate() : Result.ok(known);
      if (Result.isError(first)) {
        return first;
      }
      const read = await readFrom(first.value, start, end);
      const refused =
        Result.isError(read) &&
        read.error.httpStatus !== undefined &&
        EXPIRED_SIGNATURE_STATUSES.has(read.error.httpStatus);
      if (!refused) {
        return read;
      }
      const fresh = await locate();
      return Result.isError(fresh)
        ? fresh
        : await readFrom(fresh.value, start, end);
    },
  };
};

type DownloadShardOptions = {
  directory: string;
  snapshot: PlNsaSnapshot;
  target: PlNsaShard;
  signal?: AbortSignal | undefined;
};

/**
 * Download one shard to `directory`, resuming a partial file, and keep it
 * only if its digest is the one the repository states. Returns its path.
 *
 * A partial file survives a transient failure, so the next attempt resumes
 * where this one stopped; bytes that hash wrong are removed, because nothing
 * built on them can be right.
 */
const downloadShard = async ({
  directory,
  signal,
  snapshot,
  target,
}: DownloadShardOptions): Promise<DatasetResult<string>> => {
  const finalPath = nodePath.join(directory, nodePath.basename(target.path));
  const partialPath = `${finalPath}.partial`;
  const hasher = new Bun.CryptoHasher("sha256");

  let have = (await sizeOf(partialPath)) ?? 0;
  if (have > target.bytes) {
    await rm(partialPath, { force: true });
    have = 0;
  }
  if (have > 0) {
    await hashFile(partialPath, hasher);
  }

  const reader = shardReader(snapshot, target, signal);
  for (let start = have; start < target.bytes; start += DOWNLOAD_CHUNK_BYTES) {
    const end = Math.min(start + DOWNLOAD_CHUNK_BYTES, target.bytes) - 1;
    const bytes = await reader.read(start, end);
    if (Result.isError(bytes)) {
      return bytes;
    }
    hasher.update(bytes.value);
    await appendFile(partialPath, bytes.value);
  }

  const digest = hasher.digest("hex");
  if (digest !== target.sha256) {
    await rm(partialPath, { force: true });
    return Result.err(
      plNsaDatasetError(
        PL_NSA_FAILURE.PERMANENT,
        `${target.path} downloaded with digest ${digest}, the revision states ${target.sha256}`,
      ),
    );
  }
  await rename(partialPath, finalPath);
  return Result.ok(finalPath);
};

type HuggingFaceShardSourceOptions = {
  snapshot: PlNsaSnapshot;
  /** Where shards are kept while read; a directory per revision is made in it. */
  cacheDirectory?: string | undefined;
};

/** The default scratch location, outside any checkout. */
const DEFAULT_CACHE_DIRECTORY = nodePath.join(
  tmpdir(),
  "stella-case-law",
  "pl-nsa",
);

/**
 * Shards from the dataset repository, one on disk at a time.
 *
 * A shard found on disk is re-hashed once per process before it is trusted:
 * a file left by a crashed run can be complete in size and still wrong. A
 * shard that failed permanently is answered with the same failure, with no
 * request, for the life of the process.
 */
export const huggingFaceShardSource = ({
  cacheDirectory = DEFAULT_CACHE_DIRECTORY,
  snapshot,
}: HuggingFaceShardSourceOptions): PlNsaShardSource => {
  const directory = nodePath.join(cacheDirectory, snapshot.revision);
  const verified = new Map<number, string>();
  const permanent = new Map<number, AdapterFetchError>();

  /** Run a step for a shard, remembering a permanent failure of it. */
  const remembering = async <T>(
    target: PlNsaShard,
    step: () => Promise<DatasetResult<T>>,
  ): Promise<DatasetResult<T>> => {
    const known = permanent.get(target.index);
    if (known !== undefined) {
      return Result.err(known);
    }
    const result = await step();
    if (Result.isError(result) && isPermanentPlNsaError(result.error)) {
      permanent.set(target.index, result.error);
    }
    return result;
  };

  const evictOthers = async (keep: PlNsaShard): Promise<void> => {
    const keepName = nodePath.basename(keep.path);
    // Called after the directory is made, so a failure here is a real one.
    const entries = await readdir(directory);
    await Promise.all(
      entries
        .filter((entry) => !entry.startsWith(keepName))
        .map(
          async (entry) =>
            await rm(nodePath.join(directory, entry), { force: true }),
        ),
    );
    for (const index of verified.keys()) {
      if (index !== keep.index) {
        verified.delete(index);
      }
    }
  };

  /** The shard work in flight, so overlapping callers queue behind it. */
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * One caller at a time: two callers wanting the shard at once would each
   * download it into the same partial file, or one would evict the file the
   * other is reading. The second finds the first one's verified file.
   */
  const serialised = async <T>(step: () => Promise<T>): Promise<T> => {
    const turn = queue.then(step);
    queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return await turn;
  };

  const ensureLocal = async (
    target: PlNsaShard,
    signal?: AbortSignal,
  ): Promise<DatasetResult<string>> =>
    await serialised(async () => await ensureLocalNow(target, signal));

  const ensureLocalNow = async (
    target: PlNsaShard,
    signal?: AbortSignal,
  ): Promise<DatasetResult<string>> => {
    const known = verified.get(target.index);
    if (known !== undefined && (await sizeOf(known)) === target.bytes) {
      return Result.ok(known);
    }
    await mkdir(directory, { recursive: true });
    await evictOthers(target);

    const finalPath = nodePath.join(directory, nodePath.basename(target.path));
    if ((await sizeOf(finalPath)) === target.bytes) {
      const hasher = new Bun.CryptoHasher("sha256");
      await hashFile(finalPath, hasher);
      if (hasher.digest("hex") === target.sha256) {
        verified.set(target.index, finalPath);
        return Result.ok(finalPath);
      }
      await rm(finalPath, { force: true });
    }

    const downloaded = await downloadShard({
      directory,
      signal,
      snapshot,
      target,
    });
    if (Result.isOk(downloaded)) {
      verified.set(target.index, downloaded.value);
    }
    return downloaded;
  };

  return {
    local: async (target, signal) =>
      await remembering(target, async () =>
        Result.map(await ensureLocal(target, signal), fileBuffer),
      ),
    remote: async (target, signal) =>
      await remembering(target, async () => {
        const reader = shardReader(snapshot, target, signal);
        const buffer: AsyncBuffer = {
          byteLength: target.bytes,
          // The parquet reader only knows a buffer that resolves or rejects,
          // so a failed read is handed back as the rejection it asks for,
          // carrying the classified error the page reports.
          slice: async (start, end = target.bytes) => {
            const read = await reader.read(start, end - 1);
            return Result.isOk(read)
              ? read.value.slice().buffer
              : await Promise.reject(read.error);
          },
        };
        return await Promise.resolve(Result.ok(buffer));
      }),
  };
};
