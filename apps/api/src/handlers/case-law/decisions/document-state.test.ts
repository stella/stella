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

import { resolveDocumentState } from "@/api/handlers/case-law/decisions/get";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/lib/legal-search/corpus-storage";

const REAL_HASH = "a-real-content-hash";
const EMPTY_HASH = EMPTY_CORPUS_CONTENT_HASHES.at(0) ?? "";

/** Fails the test if the state is decided by re-reading the column. */
const noColumnRead = async (): Promise<boolean | null> => {
  throw new Error("the column was read where the row already answers");
};

type Scenario = {
  hasReadableDocument?: boolean;
  corpusPayloadUnavailable?: boolean;
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
    corpusPayloadUnavailable: false,
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
      documentReadFailed: false,
      documentUnavailable: false,
    });
  });

  test("a decision with nothing to fetch is neither", async () => {
    expect(await state({ documentUrl: null })).toEqual({
      documentPending: false,
      documentReadFailed: false,
      documentUnavailable: false,
    });
  });

  describe("a payload object storage refused", () => {
    // A trimmed canonical row keeps nothing in Postgres, so a refused
    // object leaves the read with no body and no column that can say
    // why. Reporting "neither" would render a decision with no text as a
    // complete one; the read used to fail outright instead, which loses
    // the metadata, citations and case number as well.
    test("reads as pending even where the row is corpus-served", async () => {
      expect(
        await state({
          corpusPayloadUnavailable: true,
          corpusServed: true,
          contentHash: REAL_HASH,
        }),
      ).toEqual({
        documentPending: true,
        documentReadFailed: true,
        documentUnavailable: false,
      });
    });

    test("reads as pending even where there is nothing to fetch", async () => {
      // Sources that store the document during the crawl have no
      // document URL, so nothing will re-fetch this — but the reader
      // still must not be shown a bodyless decision as a whole one.
      expect(
        await state({
          corpusPayloadUnavailable: true,
          documentUrl: null,
          corpusServed: true,
          contentHash: REAL_HASH,
        }),
      ).toEqual({
        documentPending: true,
        documentReadFailed: true,
        documentUnavailable: false,
      });
    });

    test("does not override a document the read did resolve", async () => {
      // Only one of the two payloads has to arrive: an AST refusal with
      // a text fallback that worked is still a readable decision.
      expect(
        await state({
          corpusPayloadUnavailable: true,
          hasReadableDocument: true,
        }),
      ).toEqual({
        documentPending: false,
        documentReadFailed: false,
        documentUnavailable: false,
      });
    });
  });

  test("served from the columns, NULL is pending and empty is terminal", async () => {
    expect(await state({ resolvedFulltext: null })).toEqual({
      documentPending: true,
      documentReadFailed: false,
      documentUnavailable: false,
    });
    expect(await state({ resolvedFulltext: "" })).toEqual({
      documentPending: false,
      documentReadFailed: false,
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
    ).toEqual({
      documentPending: false,
      documentReadFailed: false,
      documentUnavailable: false,
    });
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
    ).toEqual({
      documentPending: true,
      documentReadFailed: false,
      documentUnavailable: false,
    });

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
    ).toEqual({
      documentPending: false,
      documentReadFailed: false,
      documentUnavailable: true,
    });
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
    ).toEqual({
      documentPending: true,
      documentReadFailed: false,
      documentUnavailable: false,
    });

    expect(
      await state({
        corpusServed: true,
        contentHash: EMPTY_HASH,
        resolvedFulltext: "",
        readTextColumnWritten: async () => await Promise.resolve(true),
      }),
    ).toEqual({
      documentPending: false,
      documentReadFailed: false,
      documentUnavailable: true,
    });
  });

  test("a row that vanished under the read is neither", async () => {
    expect(
      await state({
        corpusServed: true,
        contentHash: EMPTY_HASH,
        readTextColumnWritten: async () => await Promise.resolve(null),
      }),
    ).toEqual({
      documentPending: false,
      documentReadFailed: false,
      documentUnavailable: false,
    });
  });
});
