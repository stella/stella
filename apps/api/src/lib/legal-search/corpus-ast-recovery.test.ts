import { Result } from "better-result";
import { expect, test } from "bun:test";

import { zstdCompress } from "@/api/lib/compression";
import { StoredCorpusValidationError } from "@/api/lib/errors/tagged-errors";
import { prepareCorpusAst } from "@/api/lib/legal-search/corpus-ast";
import { projectionAstOf } from "@/api/lib/legal-search/corpus-index-projection-executor";
import {
  parsePersistedCorpusAst,
  readCorpusAst,
  readCorpusForRecovery,
  readCorpusPayloadOrFallback,
} from "@/api/lib/legal-search/corpus-storage";

const malformed = { version: 1, blocks: [{ type: "paragraph" }] };

// A write may discard unreadable structure only when text still carries the document.
test.each([null, "", " \n"])(
  "invalid structure without usable text fails preparation: %j",
  (fallbackText) => {
    expect(() => prepareCorpusAst({ ast: malformed, fallbackText })).toThrow(
      StoredCorpusValidationError,
    );
  },
);

test("a classified store failure reaches the readable row before recovery", async () => {
  let rowRead = false;
  const row = { version: 1, blocks: [] };
  const read = await readCorpusForRecovery({
    documentId: "synthetic-decision",
    read: async () =>
      await readCorpusPayloadOrFallback({
        documentId: "synthetic-decision",
        key: "synthetic/ast",
        step: "test.astFallback",
        read: async () => parsePersistedCorpusAst(malformed),
        fallback: () => {
          rowRead = true;
          return parsePersistedCorpusAst(row);
        },
      }),
  });
  expect(read.isOk()).toBe(true);
  expect(read.unwrapOr(null)).toMatchObject(row);
  expect(rowRead).toBe(true);
});

test("typed recovery preserves the main validation contract and indexing requires text", async () => {
  const read = await readCorpusForRecovery({
    documentId: "synthetic-decision",
    read: async () => parsePersistedCorpusAst(malformed),
  });
  expect(read.isErr()).toBe(true);
  if (Result.isOk(read)) {
    return expect.unreachable();
  }
  expect(read.error).toBeInstanceOf(StoredCorpusValidationError);
  expect(read.error.code).toBe("stored_corpus_invalid");
  expect(read.error.paths.length).toBeGreaterThan(0);
  expect(JSON.stringify(read.error)).not.toContain("paragraph");
  expect(() => projectionAstOf(read, " \n")).toThrow(
    StoredCorpusValidationError,
  );
  expect(projectionAstOf(read, "Decision text.")).toBeNull();
});

test("a stored non-JSON AST has the same path-only classified failure", async () => {
  const read = await readCorpusForRecovery({
    documentId: "synthetic-decision",
    read: async () =>
      await readCorpusAst("legal-corpus/synthetic/ast.zst", {
        readObject: async () => zstdCompress("{"),
        readTombstones: async () => new Set<string>(),
      }),
  });
  expect(read.isErr()).toBe(true);
  if (Result.isOk(read)) {
    return expect.unreachable();
  }
  expect(read.error).toBeInstanceOf(StoredCorpusValidationError);
  expect(read.error.paths).toEqual(["$"]);
});
