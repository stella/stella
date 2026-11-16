import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";

import { rejectionOf } from "@stll/property-testing/rejection";
import { deferred, settledWithin } from "@stll/test-kit";

import { envBase } from "@/api/env-base";
import {
  configureS3ForTesting,
  getFreshAbortableS3,
  readS3ObjectBounded,
  resetS3ForTesting,
  S3ObjectBudgetError,
} from "@/api/lib/s3";
import { HAPPY_PATH_TIMEOUT_MS } from "@/api/tests/test-timeouts";

type ObjectBody =
  | { type: "stalled"; declaredBytes: number | undefined }
  | { type: "complete"; bytes: Uint8Array };

const withSdkObject = async (
  body: ObjectBody,
  exercise: (observation: {
    headers: Promise<{ status: number | undefined; length: unknown }>;
    closed: Promise<undefined>;
    isClosed: () => boolean;
    requests: { method: string | undefined; path: string }[];
  }) => Promise<void>,
): Promise<void> => {
  const closed = deferred<undefined>();
  const headers = deferred<{ status: number | undefined; length: unknown }>();
  const requests: { method: string | undefined; path: string }[] = [];
  // Node HTTP preserves the declared length while its unfinished body stalls.
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      path: new URL(request.url ?? "/", "http://127.0.0.1").pathname,
    });
    response.on("close", () => closed.resolve(undefined));
    const declared =
      body.type === "complete" ? body.bytes.byteLength : body.declaredBytes;
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      ...(declared === undefined ? {} : { "content-length": String(declared) }),
    });
    if (body.type === "complete") {
      response.end(body.bytes);
    } else {
      response.write(new Uint8Array([42]));
    }
  }).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a loopback TCP listener");
    }
    configureS3ForTesting({ endpoint: `http://127.0.0.1:${address.port}` });
    const client = await getFreshAbortableS3();
    const middlewareName = "observeBoundedObjectHeaders";
    client.middlewareStack.add(
      (handleRequest) => async (args) => {
        const result = await handleRequest(args);
        headers.resolve({
          status: result.output?.$metadata.httpStatusCode,
          length:
            result.output !== undefined && "ContentLength" in result.output
              ? result.output.ContentLength
              : undefined,
        });
        return result;
      },
      { step: "deserialize", priority: "high", name: middlewareName },
    );
    try {
      await exercise({
        headers: headers.promise,
        closed: closed.promise,
        isClosed: () => closed.settled(),
        requests,
      });
    } finally {
      client.middlewareStack.remove(middlewareName);
    }
  } finally {
    resetS3ForTesting();
    server.closeAllConnections();
    await server[Symbol.asyncDispose]();
  }
};

const key = "bounded-sdk/object";

describe("bounded SDK object read ownership", () => {
  test.each([undefined, 8])(
    "closes an unfinished body refused for declared length %s",
    async (declaredBytes) => {
      await withSdkObject(
        { type: "stalled", declaredBytes },
        async (observation) => {
          const caller = new AbortController();
          const error = await rejectionOf(
            readS3ObjectBounded({
              bucket: envBase.S3_BUCKET,
              key,
              maxBytes: 4,
              signal: caller.signal,
            }),
          );
          expect(await observation.headers).toEqual({
            status: 200,
            length: declaredBytes,
          });
          if (declaredBytes === undefined) {
            expect(error).toBeInstanceOf(Error);
            expect(error).toMatchObject({
              _tag: "S3ObjectReadError",
              message: `Object read for ${key} declared no usable length; refusing an unbounded read`,
            });
          } else {
            expect(error).toBeInstanceOf(S3ObjectBudgetError);
            expect(error).toMatchObject({
              message: `Object read for ${key} declares 8 bytes, past the 4-byte ceiling`,
              key,
              declaredBytes: 8,
              maxBytes: 4,
            });
          }
          expect(caller.signal.aborted).toBe(false);
          await settledWithin(observation.closed, {
            description: "the refused SDK response closing",
            timeoutMs: HAPPY_PATH_TIMEOUT_MS,
          });
          expect(observation.requests).toEqual([
            { method: "GET", path: `/${envBase.S3_BUCKET}/${key}` },
          ]);
        },
      );
    },
  );

  test.each([new Uint8Array(), new Uint8Array([1, 2, 3, 4])])(
    "completes admitted bytes without aborting the caller (%s)",
    async (bytes) => {
      await withSdkObject({ type: "complete", bytes }, async (observation) => {
        const caller = new AbortController();
        expect(
          await readS3ObjectBounded({
            bucket: envBase.S3_BUCKET,
            key,
            maxBytes: bytes.byteLength,
            signal: caller.signal,
          }),
        ).toEqual(bytes);
        expect(caller.signal.aborted).toBe(false);
        expect(observation.requests).toHaveLength(1);
      });
    },
  );

  test("caller cancellation closes a body already accepted from the SDK", async () => {
    await withSdkObject(
      { type: "stalled", declaredBytes: 4 },
      async (observation) => {
        const caller = new AbortController();
        const reason = new Error("Caller stopped the object read");
        const failure = rejectionOf(
          readS3ObjectBounded({
            bucket: envBase.S3_BUCKET,
            key,
            maxBytes: 4,
            signal: caller.signal,
          }),
        );
        expect(await observation.headers).toEqual({ status: 200, length: 4 });
        expect(observation.isClosed()).toBe(false);
        caller.abort(reason);
        expect(await failure).toBeInstanceOf(Error);
        expect(caller.signal.reason).toBe(reason);
        await settledWithin(observation.closed, {
          description: "the caller-canceled SDK response closing",
          timeoutMs: HAPPY_PATH_TIMEOUT_MS,
        });
        expect(observation.requests).toHaveLength(1);
      },
    );
  });
});
