import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { envBase } from "@/api/env-base";
import { S3ObjectBudgetError } from "@/api/lib/s3";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { testFileKey } from "@/api/tests/helpers/file-key";

import { readStoredFile } from "./stored-file";

describe("bounded stored file reads", () => {
  test("reads at the byte boundary and refuses larger objects", async () => {
    const store = startFakeS3();
    const key = testFileKey("user-files/visual-definition");
    const bytes = new TextEncoder().encode("view");
    store.put(envBase.S3_BUCKET, key, bytes, "text/plain");
    try {
      const file = await readStoredFile({
        key,
        mimeType: "text/plain",
        maxBytes: bytes.byteLength,
        signal: AbortSignal.timeout(5000),
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
