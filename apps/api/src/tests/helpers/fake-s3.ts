import { panic } from "better-result";

import { configureS3ForTesting, resetS3ForTesting } from "@/api/lib/s3";
import {
  configureS3PresignForTesting,
  resetAwsS3ClientForTesting,
} from "@/api/lib/s3-presign";

// An in-process object store speaking enough of the S3 wire protocol for
// `lib/s3.ts` to run unchanged: path-style GET/HEAD/PUT/DELETE on objects,
// server-side copy, ListObjectsV2 with continuation tokens, S3-shaped XML
// errors, and presigned GETs (the signature is not checked; the URL shape is
// what the helpers produce). Prefer this over `mock.module("@/api/lib/s3")`: the
// request shapes, error-code parsing, retries, and bounds in `s3.ts` are then
// part of what the test proves, and a test cannot pass on a fabricated
// export that the real module no longer has.
//
// Failures are injected per request, not per helper, so a test that models
// "the store rejected the write" sees the same error the SDK raises in
// production for that status and code.

export type FakeS3Object = {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
};

export type FakeS3Method = "COPY" | "DELETE" | "GET" | "HEAD" | "LIST" | "PUT";

export type FakeS3Request = {
  readonly method: FakeS3Method;
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string | null;
  /** Source of a server-side copy; `null` for every other method. */
  readonly copySourceKey: string | null;
};

export type FakeS3Failure = {
  readonly method: FakeS3Method;
  /** S3 error code, e.g. `AccessDenied`, `NoSuchBucket`, `InternalError`. */
  readonly code: string;
  readonly status: number;
  /** Restrict to one key; every key when omitted. */
  readonly key?: string;
  /** How many matching requests fail; one when omitted. */
  readonly times?: number;
};

export type FakeS3 = {
  readonly endpoint: string;
  /** Objects by `<bucket>/<key>`. */
  readonly objects: Map<string, FakeS3Object>;
  readonly requests: FakeS3Request[];
  readonly failNext: (failure: FakeS3Failure) => void;
  readonly put: (
    bucket: string,
    key: string,
    bytes: Uint8Array | string,
    contentType?: string,
  ) => void;
  readonly stop: () => void;
};

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

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

const listResponse = ({
  bucket,
  keys,
  maxKeys,
  prefix,
  startAfter,
}: {
  bucket: string;
  keys: readonly string[];
  maxKeys: number;
  prefix: string;
  startAfter: string | undefined;
}): Response => {
  const matching = keys
    .filter((key) => key.startsWith(prefix))
    .filter((key) => startAfter === undefined || key > startAfter)
    .toSorted();
  const page = matching.slice(0, maxKeys);
  const truncated = matching.length > page.length;
  const last = page.at(-1);
  const contents = page
    .map((key) => `<Contents><Key>${escapeXml(key)}</Key></Contents>`)
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
  const requests: FakeS3Request[] = [];
  const failures: { failure: FakeS3Failure; remaining: number }[] = [];

  const takeFailure = (
    method: FakeS3Method,
    key: string,
  ): FakeS3Failure | null => {
    const index = failures.findIndex(
      ({ failure }) =>
        failure.method === method &&
        (failure.key === undefined || failure.key === key),
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
    requests.push({ method, bucket, key, contentType, copySourceKey });

    const failure = takeFailure(method, key);
    if (failure !== null) {
      return errorResponse(failure.code, failure.status, key);
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
        keys: [...objects.keys()]
          .filter((id) => id.startsWith(`${bucket}/`))
          .map((id) => id.slice(bucket.length + 1)),
        maxKeys: Number(url.searchParams.get("max-keys") ?? "1000"),
        prefix: url.searchParams.get("prefix") ?? "",
        startAfter: url.searchParams.get("continuation-token") ?? undefined,
      });
    }

    const id = objectId(bucket, key);
    if (method === "COPY" && copySourceKey !== null) {
      const source = objects.get(objectId(bucket, copySourceKey));
      if (source === undefined) {
        return errorResponse("NoSuchKey", 404, copySourceKey);
      }
      objects.set(id, source);
      return new Response(
        `${XML_HEADER}<CopyObjectResult><ETag>&quot;fake&quot;</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></CopyObjectResult>`,
        { status: 200, headers: { "content-type": "application/xml" } },
      );
    }
    if (method === "PUT") {
      objects.set(id, {
        bytes: new Uint8Array(await request.arrayBuffer()),
        contentType,
      });
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
      ...(object.contentType === null
        ? {}
        : { "content-type": object.contentType }),
    };
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    return new Response(object.bytes, { status: 200, headers });
  };

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });
  const endpoint = `http://127.0.0.1:${server.port}`;
  configureS3ForTesting({ endpoint });
  // Both transports point at the same store: `lib/s3.ts` (Bun's client) and
  // the SDK v3 client `lib/s3-presign.ts` builds for copy/head.
  configureS3PresignForTesting({ endpoint });

  return {
    endpoint,
    objects,
    requests,
    failNext: (failure) => {
      failures.push({ failure, remaining: failure.times ?? 1 });
    },
    put: (bucket, key, bytes, contentType) => {
      objects.set(objectId(bucket, key), {
        bytes:
          typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
        contentType: contentType ?? null,
      });
    },
    stop: () => {
      resetS3ForTesting();
      resetAwsS3ClientForTesting();
      server.stop(true);
    },
  };
};
