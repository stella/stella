import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Base64 as hashSha256Base64 } from "@stll/sha256/node";

import { envBase } from "@/api/env-base";
import {
  deleteS3ObjectWithSignal,
  headS3ObjectWithSignal,
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

  test("a held PUT exposes completion only after applying its bytes", async () => {
    const key = "org_1/ws_1/held.txt";
    const hold = fake.holdNext({ method: "PUT", keyIncludes: key });
    const pending = writeS3ObjectWithRetry(
      { key, data: "held bytes" },
      { type: "fixture" },
    );
    await hold.reached;
    expect(fake.objects.has(`${bucket}/${key}`)).toBe(false);
    hold.release();
    await hold.completed;
    expect(
      new TextDecoder().decode(fake.objects.get(`${bucket}/${key}`)?.bytes),
    ).toBe("held bytes");
    await pending;
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
    expect(await headS3ObjectWithSignal("org_1/ws_1/doc.txt", signal)).toEqual({
      contentLength: bytes.byteLength,
      contentType: "text/plain",
    });
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

  test.each([
    new Uint8Array(),
    new Uint8Array([0, 255, 128, 1]),
    new TextEncoder().encode("Žluťoučký kůň Łódź e\u0301"),
  ])(
    "requested checksum receipts preserve the legacy digest for %j",
    async (bytes) => {
      const key = "sha256/exact-bytes";
      const written = await fetch(`${fake.endpoint}/${bucket}/${key}`, {
        signal,
        method: "PUT",
        headers: { "x-amz-checksum-algorithm": "SHA256" },
        body: bytes,
      });
      expect(written.ok).toBe(true);
      const expected = hashSha256Base64(bytes);
      const read = await fetch(`${fake.endpoint}/${bucket}/${key}`, {
        signal,
        headers: { "x-amz-checksum-mode": "ENABLED" },
      });
      expect(read.headers.get("x-amz-checksum-sha256")).toBe(expected);
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
    },
  );

  test("copies preserve bytes while validators change and checksums are requested or inherited", async () => {
    const requestSignal = AbortSignal.timeout(5000);
    const bytes = new TextEncoder().encode("same content");
    fake.put(bucket, "source", bytes);
    const source = await fetch(`${fake.endpoint}/${bucket}/source`, {
      signal: requestSignal,
    });
    const sourceValidator = source.headers.get("etag");
    const sourceBytes = new Uint8Array(await source.arrayBuffer());
    expect(sourceValidator).not.toBeNull();

    for (const key of ["copy-one", "copy-two"]) {
      const copied = await fetch(`${fake.endpoint}/${bucket}/${key}`, {
        signal: requestSignal,
        method: "PUT",
        headers: { "x-amz-copy-source": `${bucket}/source` },
      });
      const receipt = await copied.text();
      const read = await fetch(`${fake.endpoint}/${bucket}/${key}`, {
        signal: requestSignal,
        headers: { "x-amz-checksum-mode": "ENABLED" },
      });
      expect(receipt).not.toContain("ChecksumSHA256");
      expect(read.headers.get("x-amz-checksum-sha256")).toBeNull();
      expect(read.headers.get("etag")).not.toBe(sourceValidator);
      expect(receipt).toContain(
        (read.headers.get("etag") ?? "").replaceAll('"', "&quot;"),
      );
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(sourceBytes);
    }

    const requested = await fetch(`${fake.endpoint}/${bucket}/copy-checked`, {
      signal: requestSignal,
      method: "PUT",
      headers: {
        "x-amz-copy-source": `${bucket}/source`,
        "x-amz-checksum-algorithm": "SHA256",
        "x-amz-copy-source-if-match": sourceValidator ?? "",
      },
    });
    const expected = hashSha256Base64(bytes);
    expect(await requested.text()).toContain(
      `<ChecksumSHA256>${expected}</ChecksumSHA256>`,
    );
    const head = await fetch(`${fake.endpoint}/${bucket}/copy-checked`, {
      signal: requestSignal,
      method: "HEAD",
      headers: { "x-amz-checksum-mode": "ENABLED" },
    });
    expect(head.headers.get("x-amz-checksum-sha256")).toBe(expected);
    expect(head.headers.get("x-amz-checksum-type")).toBe("FULL_OBJECT");

    const checkedValidator = head.headers.get("etag");
    for (const key of ["copy-inherited", "copy-checked"]) {
      const inherited = await fetch(`${fake.endpoint}/${bucket}/${key}`, {
        signal: requestSignal,
        method: "PUT",
        headers: { "x-amz-copy-source": `${bucket}/copy-checked` },
      });
      expect(await inherited.text()).toContain(
        `<ChecksumSHA256>${expected}</ChecksumSHA256>`,
      );
      const inheritedHead = await fetch(`${fake.endpoint}/${bucket}/${key}`, {
        signal: requestSignal,
        method: "HEAD",
        headers: { "x-amz-checksum-mode": "ENABLED" },
      });
      expect(inheritedHead.headers.get("x-amz-checksum-sha256")).toBe(expected);
      expect(inheritedHead.headers.get("etag")).not.toBe(checkedValidator);
    }

    fake.put(bucket, "source", bytes);
    const staleRead = await fetch(`${fake.endpoint}/${bucket}/source`, {
      signal: requestSignal,
      headers: { "if-match": sourceValidator ?? "" },
    });
    expect(staleRead.status).toBe(412);
    await staleRead.text();
    const staleCopy = await fetch(`${fake.endpoint}/${bucket}/stale-copy`, {
      signal: requestSignal,
      method: "PUT",
      headers: {
        "x-amz-copy-source": `${bucket}/source`,
        "x-amz-copy-source-if-match": sourceValidator ?? "",
      },
    });
    expect(staleCopy.status).toBe(412);
    await staleCopy.text();
    expect(fake.objects.has(`${bucket}/stale-copy`)).toBe(false);
  });

  test("copies read the source bucket and snapshot its bytes", async () => {
    const requestSignal = AbortSignal.timeout(5000);
    fake.put("source-bucket", "same-key", "source bytes");
    fake.put(bucket, "same-key", "destination bytes");
    const copied = await fetch(`${fake.endpoint}/${bucket}/cross-copy`, {
      signal: requestSignal,
      method: "PUT",
      headers: { "x-amz-copy-source": "/source-bucket/same-key" },
    });
    expect(copied.status).toBe(200);
    await copied.text();
    const read = await fetch(`${fake.endpoint}/${bucket}/cross-copy`, {
      signal: requestSignal,
    });
    expect(await read.text()).toBe("source bytes");
    fake.put("source-bucket", "same-key", "changed source");
    const snapshot = await fetch(`${fake.endpoint}/${bucket}/cross-copy`, {
      signal: requestSignal,
    });
    expect(await snapshot.text()).toBe("source bytes");
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
    await writeS3ObjectWithRetry(
      { key: "retry/ok", data: "payload" },
      { type: "fixture" },
    );
    expect(fake.objects.has(`${bucket}/retry/ok`)).toBe(true);

    fake.failNext({ method: "PUT", code: "AccessDenied", status: 403 });
    expect(
      await rejectionOf(
        writeS3ObjectWithRetry(
          { key: "retry/denied", data: "payload" },
          { type: "fixture" },
        ),
      ),
    ).toHaveProperty("message", expect.stringMatching(/AccessDenied/u));
    expect(fake.objects.has(`${bucket}/retry/denied`)).toBe(false);
  });
});
