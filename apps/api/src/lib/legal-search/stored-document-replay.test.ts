import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { sha256Hex } from "@stll/sha256/bun";

import {
  encodeSourceRawEnvelope,
  StoredRawReadError,
  type StoredRawReparseInput,
} from "@/api/lib/legal-search/ingestion-types";
import { readStoredDocumentObject } from "@/api/lib/legal-search/stored-document-replay";

const bytes = new TextEncoder().encode("stored document");
const input = {
  raw: new TextEncoder().encode(
    encodeSourceRawEnvelope(
      {},
      {
        document: {
          location: "document-key",
          sha256: sha256Hex(bytes),
          byteLength: bytes.byteLength,
          contentType: "application/pdf",
        },
      },
    ),
  ),
  contentType: null,
  caseNumber: "case",
  sourceDocumentId: null,
  language: "sk",
  court: "court",
  ecli: null,
  decisionDate: null,
  decisionType: null,
  sourceUrl: null,
  documentUrl: null,
  metadata: {},
} as const satisfies StoredRawReparseInput;

describe("stored document replay integrity", () => {
  test("reads the exact envelope address and distinguishes absence from failure", async () => {
    const seen: string[] = [];
    expect(
      await readStoredDocumentObject(
        {
          ...input,
          readObject: async (key) => {
            seen.push(key);
            return Result.ok(bytes);
          },
        },
        "document",
      ),
    ).toEqual(Result.ok(bytes));
    expect(seen).toEqual(["document-key"]);
    expect(await readStoredDocumentObject(input, "absent")).toEqual(
      Result.ok(null),
    );
    expect(
      await readStoredDocumentObject(
        { ...input, readObject: async () => Result.ok(null) },
        "document",
      ),
    ).toEqual(Result.ok(null));
    const error = new StoredRawReadError({
      message: "transport failed",
      key: "document-key",
      cause: "test",
      permanent: false,
    });
    const failed = await readStoredDocumentObject(
      { ...input, readObject: async () => Result.err(error) },
      "document",
    );
    expect(Result.isError(failed)).toBe(true);
    if (Result.isError(failed)) {
      expect(failed.error).toBe(error);
    }
    expect(await readStoredDocumentObject(input, "document")).toMatchObject({
      status: "error",
      error: {
        _tag: "StoredRawReadError",
        cause: "object-reader-required",
        permanent: false,
      },
    });
  });

  test.each([
    new TextEncoder().encode("changed content"),
    new Uint8Array(bytes.byteLength + 1),
  ])(
    "refuses bytes that differ from the recorded digest or length",
    async (changed) => {
      expect(changed).not.toEqual(bytes);
      expect(
        await readStoredDocumentObject(
          { ...input, readObject: async () => Result.ok(changed) },
          "document",
        ),
      ).toMatchObject({
        status: "error",
        error: {
          _tag: "StoredRawReadError",
          cause: "object-integrity-mismatch",
          permanent: true,
        },
      });
    },
  );
});
