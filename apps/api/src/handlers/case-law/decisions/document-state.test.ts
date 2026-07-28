/**
 * Which of three states a decision's document is in decides whether a
 * reader's request fetches it, reports it missing, or does nothing. The
 * inputs come from three places that disagree about what "empty" means:
 * a NULL text column (never fetched), an empty one (fetched, the source
 * had nothing), and an empty corpus payload (written before the
 * document existed), and under canonical storage the columns are empty
 * for every decision by design.
 */

import { describe, expect, test } from "bun:test";

import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/handlers/case-law/corpus-storage";
import { resolveDocumentState } from "@/api/handlers/case-law/decisions/get";

const REAL_HASH = "a-real-content-hash";
const EMPTY_HASH = EMPTY_CORPUS_CONTENT_HASHES.at(0) ?? "";

/** Fails the test if the state is decided by re-reading the column. */
const noColumnRead = async (): Promise<boolean | null> => {
  throw new Error("the column was read where the row already answers");
};

type Scenario = {
  hasReadableDocument?: boolean;
  documentUrl?: string | null;
  corpusServed?: boolean;
  contentHash?: string | null;
  pgAstPresent?: boolean;
  resolvedFulltext?: string | null;
  readTextColumnWritten?: () => Promise<boolean | null>;
};

const state = async (scenario: Scenario) =>
  await resolveDocumentState({
    hasReadableDocument: false,
    documentUrl: "https://example.test/decision.pdf",
    corpusServed: false,
    contentHash: null,
    pgAstPresent: false,
    resolvedFulltext: null,
    readTextColumnWritten: noColumnRead,
    ...scenario,
  });

describe("document state", () => {
  test("a decision that read as a document is neither", async () => {
    expect(await state({ hasReadableDocument: true })).toEqual({
      documentPending: false,
      documentUnavailable: false,
    });
  });

  test("a decision with nothing to fetch is neither", async () => {
    expect(await state({ documentUrl: null })).toEqual({
      documentPending: false,
      documentUnavailable: false,
    });
  });

  test("served from the columns, NULL is pending and empty is terminal", async () => {
    expect(await state({ resolvedFulltext: null })).toEqual({
      documentPending: true,
      documentUnavailable: false,
    });
    expect(await state({ resolvedFulltext: "" })).toEqual({
      documentPending: false,
      documentUnavailable: true,
    });
  });

  test("a trimmed decision whose objects hold a document is neither", async () => {
    // Canonical storage: the columns are empty by design and the hash
    // says object storage has the document. A payload that then fails to
    // arrive is an object-storage failure the read raises, not a
    // document waiting to be fetched — and nothing here needs the
    // column, so it is not read.
    expect(
      await state({
        corpusServed: true,
        contentHash: REAL_HASH,
        resolvedFulltext: "",
      }),
    ).toEqual({ documentPending: false, documentUnavailable: false });
  });

  test("a surviving AST artifact marks the corpus copy as verbatim empty", async () => {
    // The hash is this row's own, so no constant can name it — but the
    // trim, which is what nulls the payload columns, refuses a row whose
    // objects do not hold what the columns hold. An AST column that
    // survived therefore means the objects mirror an empty payload, and
    // the decision is still waiting for its document.
    expect(
      await state({
        corpusServed: true,
        contentHash: REAL_HASH,
        pgAstPresent: true,
        resolvedFulltext: "",
        readTextColumnWritten: async () => await Promise.resolve(false),
      }),
    ).toEqual({ documentPending: true, documentUnavailable: false });

    // The same row, once its document has been fetched and marked
    // unavailable, is terminal rather than pending.
    expect(
      await state({
        corpusServed: true,
        contentHash: REAL_HASH,
        pgAstPresent: true,
        resolvedFulltext: "",
        readTextColumnWritten: async () => await Promise.resolve(true),
      }),
    ).toEqual({ documentPending: false, documentUnavailable: true });
  });

  test("an empty corpus payload falls back to what the column says", async () => {
    // Both states wrote the same empty objects, so only the row can say
    // whether the fetch has happened.
    expect(
      await state({
        corpusServed: true,
        contentHash: EMPTY_HASH,
        resolvedFulltext: "",
        readTextColumnWritten: async () => await Promise.resolve(false),
      }),
    ).toEqual({ documentPending: true, documentUnavailable: false });

    expect(
      await state({
        corpusServed: true,
        contentHash: EMPTY_HASH,
        resolvedFulltext: "",
        readTextColumnWritten: async () => await Promise.resolve(true),
      }),
    ).toEqual({ documentPending: false, documentUnavailable: true });
  });

  test("a row that vanished under the read is neither", async () => {
    expect(
      await state({
        corpusServed: true,
        contentHash: EMPTY_HASH,
        readTextColumnWritten: async () => await Promise.resolve(null),
      }),
    ).toEqual({ documentPending: false, documentUnavailable: false });
  });
});
