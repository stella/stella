import { describe, expect, test } from "bun:test";

import {
  decodeVersionCursor,
  encodeVersionCursor,
} from "@/api/handlers/entities/version-cursor";
import { brandPersistedEntityVersionId } from "@/api/lib/safe-id-boundaries";

const VERSION_ID = brandPersistedEntityVersionId(
  "018f4ad2-3a6d-7000-8b1d-44f76f5df001",
);

const encodeParts = (parts: unknown): string =>
  Buffer.from(JSON.stringify(parts)).toString("base64url");

describe("entity version page cursor", () => {
  test("roundtrips the (versionNumber, id) keyset", () => {
    const decoded = decodeVersionCursor(
      encodeVersionCursor({ versionNumber: 42, id: VERSION_ID }),
    );
    expect(decoded).toEqual({ versionNumber: 42, id: VERSION_ID });
  });

  test("rejects a cursor that is not valid base64url JSON", () => {
    expect(decodeVersionCursor("not-a-cursor")).toBeNull();
  });

  test("rejects a cursor whose array shape is wrong", () => {
    expect(decodeVersionCursor(encodeParts([42]))).toBeNull();
    expect(
      decodeVersionCursor(encodeParts([42, VERSION_ID, VERSION_ID])),
    ).toBeNull();
    expect(
      decodeVersionCursor(encodeParts({ versionNumber: 42, id: VERSION_ID })),
    ).toBeNull();
  });

  test("rejects a non-number versionNumber", () => {
    expect(decodeVersionCursor(encodeParts(["42", VERSION_ID]))).toBeNull();
  });

  // A tampered cursor whose id is a valid string but not a uuid must be
  // rejected here so it never reaches the DB's uuid cast (a 400, not a 500).
  test("rejects a tampered id that is not a uuid", () => {
    expect(decodeVersionCursor(encodeParts([42, "not-a-uuid"]))).toBeNull();
  });

  test("rejects a non-string id", () => {
    expect(decodeVersionCursor(encodeParts([42, 7]))).toBeNull();
  });
});
