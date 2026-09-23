import { panic } from "better-result";

import { configureS3ForTesting, resetS3ForTesting } from "@/api/lib/s3";
import {
  configureS3PresignForTesting,
  resetAwsS3ClientForTesting,
} from "@/api/lib/s3-presign";

// An in-process object store speaking enough of the S3 wire protocol for
// `lib/s3.ts` to run unchanged: path-style GET/HEAD/PUT/DELETE on objects,
// range GETs (see `CLOSED_RANGE_PATTERN`), server-side copy, ListObjectsV2
// with continuation tokens, S3-shaped XML errors, and presigned GETs (the
// signature is not checked; the URL shape is what the helpers produce).
// Prefer this over `mock.module("@/api/lib/s3")`: the request shapes,
// error-code parsing, retries, and bounds in `s3.ts` are then part of what
// the test proves, and a test cannot pass on a fabricated export that the
// real module no longer has.
//
// Failures are injected per request, not per helper, so a test that models
// "the store rejected the write" sees the same error the SDK raises in
// production for that status and code.

export type FakeS3Object = {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
  /** What a listing reports as the object's `LastModified`. */
  readonly lastModified: Date;
};

export type FakeS3Method = "COPY" | "DELETE" | "GET" | "HEAD" | "LIST" | "PUT";

export type FakeS3Request = {
  readonly method: FakeS3Method;
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string | null;
  /** Source of a server-side copy; `null` for every other method. */
  readonly copySourceKey: string | null;
  /** The `Range` header a GET carried; `null` when it asked for the object. */
  readonly range: string | null;
  /** The `If-None-Match` header a PUT carried; `null` for an unconditional one. */
  readonly ifNoneMatch: string | null;
};

export type FakeS3Failure = {
  readonly method: FakeS3Method;
  /** S3 error code, e.g. `AccessDenied`, `NoSuchBucket`, `InternalError`. */
  readonly code: string;
  readonly status: number;
  /** Restrict to one key; every key when omitted. */
  readonly key?: string;
  /** Restrict to keys containing this. */
  readonly keyIncludes?: string;
  /** How many matching requests fail; one when omitted. */
  readonly times?: number;
};

export type FakeS3HoldMatch = {
  readonly method: FakeS3Method;
  /** Hold only a request whose key contains this. */
  readonly keyIncludes: string;
};

export type FakeS3Hold = {
  /** Settles once a matching request is held. */
  readonly reached: Promise<undefined>;
  readonly release: () => void;
};

export type FakeS3 = {
  readonly endpoint: string;
  /** Objects by `<bucket>/<key>`. */
  readonly objects: Map<string, FakeS3Object>;
  /**
   * How many versions each `<bucket>/<key>` has been written, as a versioned
   * bucket would keep them: every applied PUT or copy adds one, a PUT refused
   * by its precondition adds none.
   */
  readonly versions: Map<string, number>;
  readonly requests: FakeS3Request[];
  readonly failNext: (failure: FakeS3Failure) => void;
  /**
   * Hold the next matching request in flight, after it reached the store and
   * before it applies, until released: a test that needs one write to land
   * after something else happened releases it at that point.
   */
  readonly holdNext: (match: FakeS3HoldMatch) => FakeS3Hold;
  readonly put: (
    bucket: string,
    key: string,
    bytes: Uint8Array | string,
    contentType?: string,
    lastModified?: Date,
  ) => void;
  readonly stop: () => void;
};

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

/** The modification time of an object a test seeded without stating one. */
const FAKE_EPOCH = new Date("2026-01-01T00:00:00.000Z");

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const errorResponse = (code: string, status: number, key: string): Response =>
  new Response(
    `${XML_HEADER}<Error><Code>${code}</Code><Message>${code}</Message><Key>${escapeXml(key)}</Key></Error>`,
    {
      status,
      headers: { "content-type": "application/xml", "x-amz-error-code": code },
    },
  );

const objectId = (bucket: string, key: string): string => `${bucket}/${key}`;

const readObjectMethod = (method: string): FakeS3Method => {
  if (
    method === "DELETE" ||
    method === "GET" ||
    method === "HEAD" ||
    method === "PUT"
  ) {
    return method;
  }
  return panic(`fake S3 received an unsupported method ${method}`);
};

/**
 * The only form `lib/s3.ts` sends: one closed byte range. An open-ended
 * (`bytes=100-`), suffix (`bytes=-100`) or multipart range is not modelled
 * and panics rather than being served as a whole object, which would let a
 * test pass against a range the store never honoured. `Range` on a HEAD and
 * `If-Range` are ignored too.
 */
const CLOSED_RANGE_PATTERN = /^bytes=(?<first>\d+)-(?<last>\d+)$/u;

type ClosedRange = { first: number; last: number };

const parseClosedRange = (range: string): ClosedRange => {
  const match = CLOSED_RANGE_PATTERN.exec(range);
  const first = match?.groups?.["first"];
  const last = match?.groups?.["last"];
  if (first === undefined || last === undefined) {
    return panic(`fake S3 received an unmodelled Range header ${range}`);
  }
  return { first: Number(first), last: Number(last) };
};

/**
 * S3's two answers to a range it cannot serve verbatim, which a caller that
 * demands the exact range it asked for has to tell apart: a range starting
 * past the last byte is unsatisfiable and answers 416, while a range that
 * merely ends past it is clamped to the last byte and answered as a 206 over
 * the shorter span.
 */
const rangeResponse = ({
  bytes,
  range,
  headers,
}: {
  bytes: Uint8Array;
  range: ClosedRange;
  headers: Record<string, string>;
}): Response => {
  const complete = bytes.byteLength;
  if (range.first >= complete) {
    return new Response(
      `${XML_HEADER}<Error><Code>InvalidRange</Code><Message>The requested range is not satisfiable</Message></Error>`,
      {
        status: 416,
        headers: {
          "content-type": "application/xml",
          "content-range": `bytes */${complete}`,
          "x-amz-error-code": "InvalidRange",
        },
      },
    );
  }
  const last = Math.min(range.last, complete - 1);
  const body = bytes.slice(range.first, last + 1);
  return new Response(body, {
    status: 206,
    headers: {
      ...headers,
      "content-length": String(body.byteLength),
      "content-range": `bytes ${range.first}-${last}/${complete}`,
    },
  });
};

const listResponse = ({
  bucket,
  objects,
  maxKeys,
  prefix,
  startAfter,
  delimiter,
}: {
  bucket: string;
  objects: ReadonlyMap<string, Date>;
  maxKeys: number;
  prefix: string;
  startAfter: string | undefined;
  delimiter: string | undefined;
}): Response => {
  // A delimiter rolls every deeper key into a common prefix, which this store
  // does not report: a caller reading one level gets that level's objects.
  const matching = [...objects.keys()]
    .filter((key) => key.startsWith(prefix))
    .filter(
      (key) =>
        delimiter === undefined ||
        !key.slice(prefix.length).includes(delimiter),
    )
    .filter((key) => startAfter === undefined || key > startAfter)
    .toSorted();
  const page = matching.slice(0, maxKeys);
  const truncated = matching.length > page.length;
  const last = page.at(-1);
  const contents = page
    .map(
      (key) =>
        `<Contents><Key>${escapeXml(key)}</Key><LastModified>${(objects.get(key) ?? FAKE_EPOCH).toISOString()}</LastModified></Contents>`,
    )
    .join("");
  const continuation =
    truncated && last !== undefined
      ? `<NextContinuationToken>${escapeXml(last)}</NextContinuationToken>`
      : "";
  return new Response(
    `${XML_HEADER}<ListBucketResult><Name>${escapeXml(bucket)}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${continuation}${contents}</ListBucketResult>`,
    { status: 200, headers: { "content-type": "application/xml" } },
  );
};

export type FakeS3Options = {
  /**
   * Hold every served response this long before applying and answering it,
   * so a test can observe a request while it is in flight. A client that
   * hangs up during the hold leaves the store unchanged, the way a cancelled
   * upload or delete never applies. Injected failures still answer at once.
   */
  readonly delayMs?: number;
};

/**
 * Start the store and point `lib/s3.ts` at it. Call `stop()` in `afterAll`
 * (or `afterEach` for a store per test); it also restores the real clients.
 */
export const startFakeS3 = ({ delayMs = 0 }: FakeS3Options = {}): FakeS3 => {
  const objects = new Map<string, FakeS3Object>();
  const versions = new Map<string, number>();
  const addVersion = (id: string): void => {
    versions.set(id, (versions.get(id) ?? 0) + 1);
  };
  const requests: FakeS3Request[] = [];
  const failures: { failure: FakeS3Failure; remaining: number }[] = [];
  const holds: {
    match: FakeS3HoldMatch;
    reached: () => void;
    released: Promise<undefined>;
  }[] = [];

  const takeFailure = (
    method: FakeS3Method,
    key: string,
  ): FakeS3Failure | null => {
    const index = failures.findIndex(
      ({ failure }) =>
        failure.method === method &&
        (failure.key === undefined || failure.key === key) &&
        (failure.keyIncludes === undefined ||
          key.includes(failure.keyIncludes)),
    );
    if (index === -1) {
      return null;
    }
    const entry = failures[index] ?? panic("failure index out of range");
    entry.remaining -= 1;
    if (entry.remaining === 0) {
      failures.splice(index, 1);
    }
    return entry.failure;
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    // Path-style addressing only: `/<bucket>/<key>`. Both Bun's client and
    // the SDK (with `forcePathStyle`) use it for a non-AWS endpoint.
    const [bucket = "", ...keyParts] = url.pathname.slice(1).split("/");
    const key = decodeURIComponent(keyParts.join("/"));
    const isList = key === "" && url.searchParams.get("list-type") === "2";
    // A server-side copy is a PUT carrying `x-amz-copy-source`; the SDK's
    // CopyObjectCommand never sends a body, so it must not be stored as one.
    const copySource = request.headers.get("x-amz-copy-source");
    const copySourceKey =
      copySource === null
        ? null
        : decodeURIComponent(copySource.replace(/^\/?[^/]+\//u, ""));
    const method = ((): FakeS3Method => {
      if (isList) {
        return "LIST";
      }
      if (copySourceKey !== null) {
        return "COPY";
      }
      return readObjectMethod(request.method);
    })();
    const contentType = request.headers.get("content-type");
    const range = method === "GET" ? request.headers.get("range") : null;
    const ifNoneMatch =
      method === "PUT" ? request.headers.get("if-none-match") : null;
    requests.push({
      method,
      bucket,
      key,
      contentType,
      copySourceKey,
      range,
      ifNoneMatch,
    });

    const failure = takeFailure(method, key);
    if (failure !== null) {
      return errorResponse(failure.code, failure.status, key);
    }

    const holdIndex = holds.findIndex(
      ({ match }) => match.method === method && key.includes(match.keyIncludes),
    );
    if (holdIndex !== -1) {
      const [hold] = holds.splice(holdIndex, 1);
      hold?.reached();
      await hold?.released;
    }

    if (delayMs > 0) {
      await Bun.sleep(delayMs);
      // The client hung up mid-request: answer without applying it, the way
      // a cancelled upload or delete leaves the store untouched.
      if (request.signal.aborted) {
        return new Response(null, { status: 499 });
      }
    }

    if (method === "LIST") {
      return listResponse({
        bucket,
        objects: new Map(
          [...objects.entries()]
            .filter(([id]) => id.startsWith(`${bucket}/`))
            .map(([id, object]) => [
              id.slice(bucket.length + 1),
              object.lastModified,
            ]),
        ),
        maxKeys: Number(url.searchParams.get("max-keys") ?? "1000"),
        prefix: url.searchParams.get("prefix") ?? "",
        // Continuation tokens are the last key served, so both ways of
        // resuming a walk read the same.
        startAfter:
          url.searchParams.get("continuation-token") ??
          url.searchParams.get("start-after") ??
          undefined,
        delimiter: url.searchParams.get("delimiter") ?? undefined,
      });
    }

    const id = objectId(bucket, key);
    if (method === "COPY" && copySourceKey !== null) {
      const source = objects.get(objectId(bucket, copySourceKey));
      if (source === undefined) {
        return errorResponse("NoSuchKey", 404, copySourceKey);
      }
      // Snapshot, as S3 does: the copy must not alias the source's bytes.
      objects.set(id, {
        ...source,
        bytes: source.bytes.slice(),
        lastModified: new Date(),
      });
      addVersion(id);
      return new Response(
        `${XML_HEADER}<CopyObjectResult><ETag>&quot;fake&quot;</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></CopyObjectResult>`,
        { status: 200, headers: { "content-type": "application/xml" } },
      );
    }
    if (method === "PUT") {
      // The body is read before the precondition is checked, so the check
      // and the write below happen with no await between them: two
      // concurrent conditional PUTs cannot both see the key empty.
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (ifNoneMatch === "*" && objects.has(id)) {
        return errorResponse("PreconditionFailed", 412, key);
      }
      objects.set(id, { bytes, contentType, lastModified: new Date() });
      addVersion(id);
      return new Response(null, { status: 200, headers: { etag: '"fake"' } });
    }
    if (method === "DELETE") {
      objects.delete(id);
      return new Response(null, { status: 204 });
    }

    const object = objects.get(id);
    if (object === undefined) {
      return errorResponse("NoSuchKey", 404, key);
    }
    const headers: Record<string, string> = {
      "content-length": String(object.bytes.byteLength),
      // S3 answers every object read with a validator, and callers pass it
      // through to their own clients; a store with no ETag would let that
      // pass-through look tested when nothing had one to pass.
      etag: `"${new Bun.CryptoHasher("md5").update(object.bytes).digest("hex")}"`,
      ...(object.contentType === null
        ? {}
        : { "content-type": object.contentType }),
    };
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    if (range === null) {
      return new Response(object.bytes, { status: 200, headers });
    }
    return rangeResponse({
      bytes: object.bytes,
      range: parseClosedRange(range),
      headers,
    });
  };

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });
  const endpoint = server.url.origin;
  configureS3ForTesting({ endpoint });
  // Both transports point at the same store: `lib/s3.ts` (Bun's client) and
  // the SDK v3 client `lib/s3-presign.ts` builds for copy/head.
  configureS3PresignForTesting({ endpoint });

  return {
    endpoint,
    objects,
    versions,
    requests,
    failNext: (failure) => {
      failures.push({ failure, remaining: failure.times ?? 1 });
    },
    holdNext: (match) => {
      const reached = Promise.withResolvers<undefined>();
      const released = Promise.withResolvers<undefined>();
      holds.push({
        match,
        reached: () => {
          reached.resolve(undefined);
        },
        released: released.promise,
      });
      return {
        reached: reached.promise,
        release: () => {
          released.resolve(undefined);
        },
      };
    },
    put: (bucket, key, bytes, contentType, lastModified = FAKE_EPOCH) => {
      objects.set(objectId(bucket, key), {
        // Snapshot the caller's buffer so a later mutation cannot rewrite
        // a stored object.
        bytes:
          typeof bytes === "string"
            ? new TextEncoder().encode(bytes)
            : bytes.slice(),
        contentType: contentType ?? null,
        lastModified,
      });
    },
    stop: () => {
      resetS3ForTesting();
      resetAwsS3ClientForTesting();
      void server.stop(true);
    },
  };
};
