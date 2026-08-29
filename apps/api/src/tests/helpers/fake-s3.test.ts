import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { envBase } from "@/api/env-base";
import {
  deleteS3ObjectWithSignal,
  getS3ObjectSizeWithSignal,
  isMissingS3ObjectError,
  listS3ObjectKeys,
  putS3ObjectWithSignal,
  readS3ArrayBuffer,
  readS3ObjectBounded,
  readS3ObjectIfPresent,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";

import { startFakeS3 } from "./fake-s3";
import type { FakeS3 } from "./fake-s3";

// The fake is only as good as the real helpers it can carry, so every helper
// a migrated test may reach runs here end to end: both transports (the SDK
// client and Bun's presign-and-fetch path), the error-code parsing that
// distinguishes absence from failure, pagination, and injected rejections.
describe("fake S3 carries the real s3 helpers", () => {
  let fake: FakeS3;
  const bucket = envBase.S3_BUCKET;
  const signal = new AbortController().signal;

  beforeEach(() => {
    fake = startFakeS3();
  });

  afterEach(() => {
    fake.stop();
  });

  test("round-trips an object through the SDK and presigned transports", async () => {
    const bytes = new TextEncoder().encode("hello object");
    await putS3ObjectWithSignal(
      "org_1/ws_1/doc.txt",
      bytes,
      "text/plain",
      signal,
    );

    expect(fake.objects.get(`${bucket}/org_1/ws_1/doc.txt`)?.contentType).toBe(
      "text/plain",
    );
    expect(await getS3ObjectSizeWithSignal("org_1/ws_1/doc.txt", signal)).toBe(
      bytes.byteLength,
    );
    expect(
      new TextDecoder().decode(await readS3ArrayBuffer("org_1/ws_1/doc.txt")),
    ).toBe("hello object");
    expect(
      await readS3ObjectBounded({
        bucket,
        key: "org_1/ws_1/doc.txt",
        maxBytes: 64,
        signal,
      }),
    ).toEqual(bytes);

    await deleteS3ObjectWithSignal("org_1/ws_1/doc.txt", signal);
    expect(fake.objects.size).toBe(0);
  });

  test("reports absence as absence and a rejection as a failure", async () => {
    expect(await readS3ObjectIfPresent("missing", signal)).toBeNull();

    fake.failNext({ method: "GET", code: "AccessDenied", status: 403 });
    const failure = await readS3ObjectIfPresent("missing", signal).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ name: "AccessDenied" });
    expect(isMissingS3ObjectError(failure)).toBe(false);
  });

  test("lists a prefix one past the ceiling and inside the tenant", async () => {
    for (const index of [1, 2, 3, 4, 5]) {
      fake.put(bucket, `org_1/ws_1/file_${index}`, "x");
    }
    fake.put(bucket, "org_2/ws_1/file_1", "x");

    const keys = await listS3ObjectKeys({
      bucket,
      prefix: "org_1/",
      maxKeys: 2,
      signal,
    });

    // One past the ceiling signals overflow; the sibling tenant never appears.
    expect(keys).toEqual([
      "org_1/ws_1/file_1",
      "org_1/ws_1/file_2",
      "org_1/ws_1/file_3",
    ]);
    // The helper asks for `maxKeys + 1` up front, so one page settles it.
    expect(
      fake.requests.filter(({ method }) => method === "LIST"),
    ).toHaveLength(1);
  });

  test("retries a transient write and stops on a terminal rejection", async () => {
    fake.failNext({ method: "PUT", code: "InternalError", status: 500 });
    await writeS3ObjectWithRetry({ key: "retry/ok", data: "payload" });
    expect(fake.objects.has(`${bucket}/retry/ok`)).toBe(true);

    fake.failNext({ method: "PUT", code: "AccessDenied", status: 403 });
    expect(
      writeS3ObjectWithRetry({ key: "retry/denied", data: "payload" }),
    ).rejects.toThrow(/AccessDenied/u);
    expect(fake.objects.has(`${bucket}/retry/denied`)).toBe(false);
  });
});
