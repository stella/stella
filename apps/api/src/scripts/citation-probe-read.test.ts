import { describe, expect, test } from "bun:test";

import {
  CitationProbeS3ReadError,
  hasNoUsableDocuments,
  readAst,
} from "@/api/scripts/citation-probe-read";

const TEXT_KEY = "legal-corpus/documents/example/text.zst";

/**
 * bun-types declares `.rejects.toThrow` as void, so awaiting it trips
 * type-aware lint; capture the rejection explicitly instead.
 */
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => null,
    (error: unknown) => error,
  );

describe("citation probe AST reads", () => {
  test("only a missing AST is unavailable", async () => {
    const missing = new CitationProbeS3ReadError({
      message: "s3.get: failed with 404",
      status: 404,
    });
    const readObject = async (key: string) => {
      expect(key).toBe("legal-corpus/documents/example/ast.json.zst");
      throw missing;
    };
    expect(await readAst(TEXT_KEY, readObject)).toEqual({
      status: "unavailable",
    });
  });

  test.each([
    new CitationProbeS3ReadError({
      message: "s3.get: failed with 503",
      status: 503,
    }),
    new Error("AST read timed out"),
    new Error("AST decompression failed"),
  ])(
    "an operational AST failure rejects instead of disappearing",
    async (failure) => {
      const rejection = await rejectionOf(
        readAst(TEXT_KEY, async () => {
          throw failure;
        }),
      );
      expect(rejection).toBe(failure);
    },
  );
});

describe("citation probe run", () => {
  test("sampled keys with no fulfilled document reads make the run unusable", () => {
    expect(hasNoUsableDocuments(3, [])).toBe(true);
    expect(hasNoUsableDocuments(0, [])).toBe(false);
    expect(hasNoUsableDocuments(3, [{ empty: true, unread: false }])).toBe(
      true,
    );
    expect(hasNoUsableDocuments(3, [{ empty: false, unread: false }])).toBe(
      false,
    );
  });

  test("a run whose every document went unread is unusable", () => {
    expect(
      hasNoUsableDocuments(2, [
        { empty: false, unread: true },
        { empty: false, unread: true },
      ]),
    ).toBe(true);
    expect(
      hasNoUsableDocuments(2, [
        { empty: false, unread: true },
        { empty: false, unread: false },
      ]),
    ).toBe(false);
  });
});
