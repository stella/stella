import { S3Client as AwsS3Client } from "@aws-sdk/client-s3";
import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/files/utils";
import { LIMITS } from "@/api/lib/limits";
import { recognizePdfTextLocally } from "@/api/lib/ocr-local/recognize-local";
import {
  resetAwsS3ClientForTesting,
  S3PresignError,
  setTenantS3OperationHooksForTesting,
} from "@/api/lib/s3-presign";
import type { S3SigningScope } from "@/api/lib/s3-presign";

/**
 * The classes these pin: the OCR source is read only through the run's
 * organization/workspace scope, and size limits on untrusted input are
 * enforced before the input is materialized (or, when storage declares no
 * size, right after the read), in every case before a subprocess is spawned.
 */

type TenantS3Hooks = Parameters<typeof setTenantS3OperationHooksForTesting>[0];
type RunWorker = NonNullable<
  Parameters<typeof recognizePdfTextLocally>[0]["runWorker"]
>;

const organizationId = toSafeId<"organization">("org_ocr");
const workspaceId = toSafeId<"workspace">("ws_ocr");
const runScope = { organizationId, workspaceId } satisfies S3SigningScope;
const sourceKey = createFileKey({
  organizationId,
  workspaceId,
  fileId: "file",
  mimeType: "application/pdf",
});
const SOURCE_BYTES = new TextEncoder().encode("%PDF-1.7 scanned source");
const WORKER_OUTPUT = JSON.stringify({
  pages: [
    {
      width: 100,
      height: 100,
      lines: [{ box: [10, 10, 60, 20], confidence: 0.9, text: "Hello" }],
    },
  ],
});

const client = new AwsS3Client({
  credentials: {
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  },
  region: "us-east-1",
});

const waitForAbort = async (signal: AbortSignal): Promise<never> =>
  await new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Aborted", "AbortError"),
        ),
      { once: true },
    );
  });

type StorageFake = {
  resolvedScopes: { key: string; scope: S3SigningScope }[];
  reads: number;
};

/** A documents bucket holding `body`, reached only through the tenant seam. */
const installStorage = ({
  declaredSize = SOURCE_BYTES.byteLength,
  body = SOURCE_BYTES,
  headObjectSize,
  readObject,
}: {
  declaredSize?: number | null;
  body?: Uint8Array;
  headObjectSize?: TenantS3Hooks["headObjectSize"];
  readObject?: TenantS3Hooks["readObject"];
}): StorageFake => {
  const fake: StorageFake = { resolvedScopes: [], reads: 0 };
  setTenantS3OperationHooksForTesting({
    resolveClient: async ({ key, scope }) => {
      fake.resolvedScopes.push({ key, scope });
      return client;
    },
    headObjectSize: headObjectSize ?? (async () => declaredSize),
    readObject: async (readClient, command, signal) => {
      fake.reads += 1;
      return readObject === undefined
        ? body
        : await readObject(readClient, command, signal);
    },
    writeObject: async () => {
      throw new Error("OCR must not write the source");
    },
  });
  return fake;
};

const createWorkerFake = () => {
  const stdins: Uint8Array[] = [];
  const runWorker: RunWorker = async ({ stdin }) => {
    stdins.push(new Uint8Array(await stdin.arrayBuffer()));
    return Result.ok(WORKER_OUTPUT);
  };
  return { runWorker, stdins };
};

const recognize = async ({
  runWorker,
  scope = runScope,
  signal = new AbortController().signal,
}: {
  runWorker: RunWorker;
  scope?: S3SigningScope;
  signal?: AbortSignal;
}) =>
  await recognizePdfTextLocally({
    // The configuration gate sits before the behavior under test.
    resolveModelDir: () => "/tmp/ocr-models-test-env",
    runWorker,
    scope,
    signal,
    sourceKey,
  });

afterEach(() => {
  resetAwsS3ClientForTesting();
});

describe("local OCR source reads", () => {
  test("reads the source within the run's scope and recognizes those bytes", async () => {
    const storage = installStorage({});
    const worker = createWorkerFake();

    const result = await recognize({ runWorker: worker.runWorker });

    expect(Result.isOk(result) ? result.value.text : result.error).toBe(
      "Hello",
    );
    expect(worker.stdins).toEqual([SOURCE_BYTES]);
    // Both the size check and the body read resolve credentials for exactly
    // the run's organization/workspace and the run's source key.
    expect(storage.resolvedScopes).toEqual([
      { key: sourceKey, scope: runScope },
      { key: sourceKey, scope: runScope },
    ]);
  });

  test("refuses a source outside the given scope before resolving credentials", async () => {
    const storage = installStorage({});
    const worker = createWorkerFake();

    const result = await recognize({
      runWorker: worker.runWorker,
      scope: {
        organizationId,
        workspaceId: toSafeId<"workspace">("ws_other"),
      },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.code).toBe("request_failed");
      expect(result.error.cause).toBeInstanceOf(S3PresignError);
    }
    expect(storage.resolvedScopes).toEqual([]);
    expect(storage.reads).toBe(0);
    expect(worker.stdins).toEqual([]);
  });
});

describe("local OCR size bounds", () => {
  test("a declared oversized source is refused before the object is read", async () => {
    const storage = installStorage({
      declaredSize: LIMITS.documentOcrSourceMaxBytes + 1,
    });
    const worker = createWorkerFake();

    const result = await recognize({ runWorker: worker.runWorker });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.code).toBe("response_too_large");
    }
    expect(storage.reads).toBe(0);
    expect(worker.stdins).toEqual([]);
  });

  test("an undeclared size is still bounded after the read, before any spawn", async () => {
    const storage = installStorage({
      declaredSize: null,
      body: new Uint8Array(LIMITS.documentOcrSourceMaxBytes + 1),
    });
    const worker = createWorkerFake();

    const result = await recognize({ runWorker: worker.runWorker });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.code).toBe("response_too_large");
    }
    expect(storage.reads).toBe(1);
    expect(worker.stdins).toEqual([]);
  });
});

describe("local OCR cancellation", () => {
  test("cancelling during the size check aborts it and never reads the body", async () => {
    const controller = new AbortController();
    const reason = new Error("run cancelled");
    const storage = installStorage({
      headObjectSize: async (_client, _command, signal) => {
        queueMicrotask(() => controller.abort(reason));
        return await waitForAbort(signal);
      },
    });
    const worker = createWorkerFake();

    const result = await recognize({
      runWorker: worker.runWorker,
      signal: controller.signal,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.code).toBe("request_failed");
      expect(result.error.cause).toBe(reason);
    }
    expect(storage.reads).toBe(0);
    expect(worker.stdins).toEqual([]);
  });

  test("cancelling during the body read aborts it and never spawns the worker", async () => {
    const controller = new AbortController();
    const reason = new Error("run cancelled");
    installStorage({
      readObject: async (_client, _command, signal) => {
        queueMicrotask(() => controller.abort(reason));
        return await waitForAbort(signal);
      },
    });
    const worker = createWorkerFake();

    const result = await recognize({
      runWorker: worker.runWorker,
      signal: controller.signal,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.code).toBe("request_failed");
      expect(result.error.cause).toBe(reason);
    }
    expect(worker.stdins).toEqual([]);
  });
});
