import { afterEach, beforeEach, expect, test } from "bun:test";

import { envBase } from "@/api/env-base";
import {
  loadClientPreview,
  type QueuedClientPreview,
  removeClientPreview,
} from "@/api/lib/uploads/client-preview";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";

const bucket = envBase.S3_BUCKET;
const key = "org/ws/tmp/upload-preview";
const staged = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

// The declared checksum does not match the staged bytes, so the job refuses
// the preview before any image decoding or scanning.
const queued: QueuedClientPreview = {
  key,
  mimeType: "image/jpeg",
  size: staged.byteLength,
  sha256Hex: "0".repeat(64),
  width: 1024,
  height: 768,
};

let fake: FakeS3;

beforeEach(() => {
  fake = startFakeS3();
  fake.put(bucket, key, staged, "image/jpeg");
});

afterEach(() => {
  fake.stop();
});

test("reading a staged preview leaves it for a retried attempt", async () => {
  const loaded = await loadClientPreview({ original: null, queued });

  expect(loaded).toEqual({ type: "refused", reason: "checksum" });
  expect(fake.objects.has(`${bucket}/${key}`)).toBe(true);
  expect(fake.requests.some(({ method }) => method === "DELETE")).toBe(false);
});

test("a settled derivative removes its staged preview", async () => {
  await removeClientPreview(queued);

  expect(fake.objects.has(`${bucket}/${key}`)).toBe(false);
});

test("a failed removal is left to the bucket's temporary-upload rule", async () => {
  fake.failNext({
    method: "DELETE",
    code: "InternalError",
    status: 500,
    times: 10,
  });

  await removeClientPreview(queued);

  expect(fake.objects.has(`${bucket}/${key}`)).toBe(true);
});
