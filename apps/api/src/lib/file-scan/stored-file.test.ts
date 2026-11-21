import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";
import { createTestClock } from "@stll/test-kit";

import { envBase } from "@/api/env-base";
import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import { runWithPublicReadScope } from "@/api/lib/legal-search/public-read-timeout-context";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { currentReadWork } from "@/api/lib/observability/request-work";
import { OBJECT_READ_TIMEOUT_MS, S3ObjectBudgetError } from "@/api/lib/s3";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { testFileKey } from "@/api/tests/helpers/file-key";
import {
  responseByteFile,
  responseByteStream,
} from "@/api/tests/helpers/response-byte-stream";

import { readStoredFile } from "./stored-file";

describe("bounded stored file reads", () => {
  test("reads at the byte boundary and refuses larger objects", async () => {
    const store = startFakeS3();
    const key = testFileKey("user-files/visual-definition");
    const bytes = new TextEncoder().encode("view");
    store.put(envBase.S3_BUCKET, key, bytes, "text/plain");
    try {
      const file = await runWithQueryCounter(async () => {
        const stored = await readStoredFile({
          key,
          mimeType: "text/plain",
          maxBytes: bytes.byteLength,
          signal: AbortSignal.timeout(5000),
        });
        expect(currentReadWork()?.storageReadBytes).toBe(bytes.byteLength);
        return stored;
      });
      expect(new Uint8Array(file.bytes)).toEqual(bytes);
      const error = await rejectionOf(
        readStoredFile({
          key,
          mimeType: "text/plain",
          maxBytes: bytes.byteLength - 1,
          signal: AbortSignal.timeout(5000),
        }),
      );
      expect(error).toBeInstanceOf(S3ObjectBudgetError);
    } finally {
      store.stop();
    }
  });
});

describe("stored file default byte budgets", () => {
  test.each([
    ["default", "oversized"],
    ["caller", "oversized"],
    ["default", "undeclared"],
    ["caller", "undeclared"],
  ] as const)(
    "%s signal refuses an %s body without an explicit cap",
    async (mode, fault) => {
      const key = testFileKey("user-files/default-budget");
      const byteLength = FILE_SIZE_LIMIT_BYTES.document + 1;
      using bodyFile = responseByteFile(byteLength);
      const store = startFakeS3({
        readResponse: ({ headers }) => {
          const responseHeaders = new Headers(headers);
          if (fault === "undeclared") {
            responseHeaders.delete("content-length");
          } else {
            responseHeaders.set("content-length", String(byteLength));
          }
          return new Response(
            fault === "undeclared"
              ? responseByteStream(byteLength).body
              : bodyFile.body,
            { headers: responseHeaders },
          );
        },
      });
      store.put(envBase.S3_BUCKET, key, new Uint8Array(1), "text/plain");
      try {
        const error = await rejectionOf(
          readStoredFile({
            key,
            mimeType: "text/plain",
            ...(mode === "caller"
              ? { signal: new AbortController().signal }
              : {}),
          }),
        );
        if (fault === "oversized") {
          expect(error).toBeInstanceOf(S3ObjectBudgetError);
        } else {
          expect(error).toMatchObject({
            _tag: "S3ObjectReadError",
            message: expect.stringContaining("declared no usable length"),
          });
        }
        expect(
          store.requests.filter(({ method }) => method === "GET"),
        ).toHaveLength(1);
      } finally {
        store.stop();
      }
    },
  );

  test.each(["default", "caller"] as const)(
    "%s signal preserves exact bytes, provenance, metadata and metering",
    async (mode) => {
      const store = startFakeS3();
      const key = testFileKey("user-files/default-budget-metadata");
      const bytes = new TextEncoder().encode("Žluťoučký dokument");
      store.put(envBase.S3_BUCKET, key, bytes, "text/plain");
      try {
        const file = await runWithQueryCounter(async () => {
          const stored = await readStoredFile({
            key,
            mimeType: "text/plain",
            fileName: "document.txt",
            ...(mode === "caller"
              ? { signal: new AbortController().signal }
              : {}),
          });
          expect(currentReadWork()?.storageReadBytes).toBe(bytes.byteLength);
          return stored;
        });
        expect(new Uint8Array(file.bytes)).toEqual(bytes);
        expect(file.fileName).toBe("document.txt");
        expect(file.mimeType).toBe("text/plain");
        expect(file.source).toEqual({ type: "stored", key });
        expect(file.scanWarnings).toBeNull();
      } finally {
        store.stop();
      }
    },
  );
});

describe("stored file default signal ownership", () => {
  test.each(["default", "caller", "explicit-cap"] as const)(
    "%s signal retains its original deadline authority",
    async (mode) => {
      const clock = createTestClock();
      const defaultDeadline = new AbortController();
      const caller = new AbortController();
      const originalTimeout = AbortSignal.timeout;
      const deadlines: number[] = [];
      const timeout = spyOn(AbortSignal, "timeout").mockImplementation(
        (milliseconds) => {
          if (milliseconds !== OBJECT_READ_TIMEOUT_MS) {
            return originalTimeout(milliseconds);
          }
          deadlines.push(milliseconds);
          void clock
            .sleep(milliseconds)
            .then(() =>
              defaultDeadline.abort(
                new DOMException("Object read timed out", "TimeoutError"),
              ),
            );
          return defaultDeadline.signal;
        },
      );
      const store = startFakeS3();
      const key = testFileKey("user-files/default-deadline");
      store.put(envBase.S3_BUCKET, key, "document", "text/plain");
      const hold = store.holdNext({ method: "GET", keyIncludes: key });
      let settled = false;
      const input =
        mode === "explicit-cap"
          ? {
              key,
              mimeType: "text/plain",
              maxBytes: 8,
              signal: caller.signal,
            }
          : {
              key,
              mimeType: "text/plain",
              ...(mode === "caller" ? { signal: caller.signal } : {}),
            };
      const outcome = Result.tryPromise(
        async () => await readStoredFile(input),
      ).then((result) => {
        settled = true;
        return result;
      });
      try {
        await hold.reached;
        expect(deadlines).toEqual(
          mode === "default" ? [OBJECT_READ_TIMEOUT_MS] : [],
        );
        await clock.advance(OBJECT_READ_TIMEOUT_MS - 1);
        expect(settled).toBe(false);
        if (mode === "default") {
          await clock.advance(1);
        } else {
          await clock.advance(2);
          expect(settled).toBe(false);
          if (mode === "caller") {
            caller.abort(new Error("Caller stopped the read"));
          } else {
            hold.release();
          }
        }
        const result = await outcome;
        if (mode === "explicit-cap") {
          expect(Result.isOk(result)).toBe(true);
          if (Result.isOk(result)) {
            expect(new TextDecoder().decode(result.value.bytes)).toBe(
              "document",
            );
          }
        } else {
          expect(Result.isError(result)).toBe(true);
          if (Result.isError(result)) {
            expect(result.error.cause).toMatchObject({
              name: mode === "default" ? "TimeoutError" : "AbortError",
            });
          }
        }
      } finally {
        hold.release();
        await outcome;
        timeout.mockRestore();
        store.stop();
      }
    },
  );
});

describe("stored file default transport ownership", () => {
  test("a transient storage refusal is surfaced without an SDK retry", async () => {
    const store = startFakeS3();
    const key = testFileKey("user-files/default-no-retry");
    store.put(envBase.S3_BUCKET, key, "document", "text/plain");
    store.failNext({ method: "GET", key, code: "InternalError", status: 500 });
    try {
      expect(
        await rejectionOf(readStoredFile({ key, mimeType: "text/plain" })),
      ).toMatchObject({ _tag: "S3ObjectReadError", status: 500 });
      expect(
        store.requests.filter(({ method }) => method === "GET"),
      ).toHaveLength(1);
    } finally {
      store.stop();
    }
  });

  test("an ambient public-read abort cancels the default storage request", async () => {
    const store = startFakeS3();
    const key = testFileKey("user-files/default-public-scope");
    store.put(envBase.S3_BUCKET, key, "document", "text/plain");
    const hold = store.holdNext({ method: "GET", keyIncludes: key });
    const controller = new AbortController();
    const reason = new DOMException("Request ended", "AbortError");
    const reading = runWithPublicReadScope(
      { budgetMs: 1000, signal: controller.signal },
      async () => await readStoredFile({ key, mimeType: "text/plain" }),
    );
    try {
      await hold.reached;
      controller.abort(reason);
      const result = await reading;
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toBe(reason);
      }
    } finally {
      hold.release();
      await reading;
      store.stop();
    }
  });
});
