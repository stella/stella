import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { deriveFileObject } from "@/api/lib/files/file-object-ids";

describe("deriveFileObject", () => {
  test("is stable across finalize retries", () => {
    const first = deriveFileObject({ namespace: "upload-1", slot: "message" });
    const retry = deriveFileObject({ namespace: "upload-1", slot: "message" });

    expect(first).toBe(retry);
    expect(v.is(v.pipe(v.string(), v.uuid()), first)).toBe(true);
  });

  test("separates upload namespaces and object slots", () => {
    const values = new Set([
      deriveFileObject({ namespace: "upload-1", slot: "message" }),
      deriveFileObject({ namespace: "upload-1", slot: "attachment:0" }),
      deriveFileObject({ namespace: "upload-2", slot: "message" }),
    ]);

    expect(values.size).toBe(3);
  });
});
