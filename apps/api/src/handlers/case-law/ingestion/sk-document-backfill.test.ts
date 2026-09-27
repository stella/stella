/**
 * The queue's priority is expressed entirely in SQL, and a wrong
 * predicate or ORDER BY is invisible at runtime: the loop still drains,
 * just in the wrong order, and the decisions readers are waiting on
 * stay unreadable. These assertions pin the shape; the Postgres suite
 * (`sk-document-backfill.db.test.ts`) pins the resulting row order.
 */

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import {
  DOCUMENT_FETCH_FAILURE,
  fetchPdfBytes,
  MAX_DOCUMENT_FETCH_ATTEMPTS,
  MAX_PRIORITY_FETCH_ATTEMPTS,
  parkedDocumentPredicate,
  type PdfFetchResult,
  remainingDocumentOrder,
  remainingDocumentPredicate,
  requestedDocumentOrder,
  requestedDocumentPredicate,
  type SkDocumentFetch,
} from "@/api/lib/legal-search/sk-document-backfill";

const dialect = new PgDialect();

const compileCondition = (condition: SQL | undefined) =>
  dialect.sqlToQuery(condition ?? panic("queue predicate is empty"));

const compileOrder = (fragments: readonly SQL[]) =>
  fragments.map((fragment) => dialect.sqlToQuery(fragment).sql).join(", ");

describe("deferred document queue shape", () => {
  test("treats a persisted out-of-boundary URL as unavailable", async () => {
    const result = await fetchPdfBytes({
      documentUrl: "http://legacy.invalid/document.pdf",
      // The boundary is checked before anything is downloaded, so a fetcher
      // that cannot run is the assertion: reaching it would be the bug.
      fetchDocument: () => panic("off-origin URL must not be fetched"),
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ type: "absent" });
  });

  test("the remaining tier stops handing out a decision at the parking threshold", () => {
    const { sql, params } = compileCondition(remainingDocumentPredicate);

    expect(sql).toContain(`"document_fetch_attempts" <`);
    expect(params).toContain(MAX_DOCUMENT_FETCH_ATTEMPTS);
    // The requested tier retires earlier, so a parked decision is in
    // neither tier and the parked set is exactly what both leave.
    expect(MAX_PRIORITY_FETCH_ATTEMPTS).toBeLessThan(
      MAX_DOCUMENT_FETCH_ATTEMPTS,
    );
    const parked = compileCondition(parkedDocumentPredicate);
    expect(parked.sql).toContain(`"document_fetch_attempts" >=`);
    expect(parked.params).toContain(MAX_DOCUMENT_FETCH_ATTEMPTS);
  });
});

const PUBLISHER_URL =
  "https://obcan.justice.sk/content/public/item/6fe03973-7694-432b-9ebd-dfa4104ef742";

const download = async (
  fetchDocument: SkDocumentFetch,
): Promise<PdfFetchResult> =>
  await fetchPdfBytes({
    documentUrl: PUBLISHER_URL,
    fetchDocument,
    signal: new AbortController().signal,
  });

/**
 * What the promise rejected with; a resolution comes back wrapped so it can
 * never pass for the expected error. bun-types declares `.rejects.toX` as
 * void, so awaiting it trips type-aware lint; capture the rejection instead.
 */
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    (value: unknown) => ({ resolved: value }),
    (error: unknown) => error,
  );

/** A network failure as Bun reports it: a `TypeError` carrying a code. */
const bunNetworkError = (code: string): TypeError =>
  Object.assign(new TypeError(`${code} fetching the document`), { code });

describe("one document's download", () => {
  test("every refusal but not-found and slow-down is that document's own failure", async () => {
    // A throw backs the whole walk off, so only an answer about every
    // document may throw. Swept over every non-OK status rather than a
    // few examples: one status wrongly thrown is enough to let a handful
    // of refused documents hold the queue.
    for (let status = 400; status < 600; status += 1) {
      if (status === 404 || status === 410 || status === 429) {
        continue;
      }
      const result = await download(
        async () => await Promise.resolve(new Response(null, { status })),
      );

      expect(result).toEqual({
        type: "failed",
        failure: DOCUMENT_FETCH_FAILURE.PUBLISHER_STATUS,
        detail: `http-${status}`,
      });
    }
  });

  test("not found and gone mean there is nothing to fetch", async () => {
    for (const status of [404, 410]) {
      const result = await download(
        async () => await Promise.resolve(new Response(null, { status })),
      );

      expect(result).toEqual({ type: "absent" });
    }
  });

  test("a publisher asking the walk to slow down throws, so the walk backs off", async () => {
    const result = download(
      async () => await Promise.resolve(new Response(null, { status: 429 })),
    );

    expect(await rejectionOf(result)).toBeInstanceOf(AdapterFetchError);
  });

  test("a connection that fails for this document is its own failure", async () => {
    for (const code of [
      "ECONNRESET",
      "ConnectionRefused",
      "UnexpectedRedirect",
    ]) {
      const result = await download(async () => {
        throw bunNetworkError(code);
      });

      expect(result).toEqual({
        type: "failed",
        failure: DOCUMENT_FETCH_FAILURE.NETWORK,
        detail: `TypeError:${code}`,
      });
    }
  });

  test("a body cut off mid-download is that document's own failure", async () => {
    const result = await download(async () => {
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new Uint8Array([0x25, 0x50]));
          controller.error(bunNetworkError("ECONNRESET"));
        },
      });
      return await Promise.resolve(new Response(body));
    });

    expect(result).toEqual({
      type: "failed",
      failure: DOCUMENT_FETCH_FAILURE.NETWORK,
      detail: "TypeError:ECONNRESET",
    });
  });

  test("a download that runs out of time is that document's own failure", async () => {
    const result = await download(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });

    expect(result).toEqual({
      type: "failed",
      failure: DOCUMENT_FETCH_FAILURE.NETWORK,
      detail: "TimeoutError",
    });
  });

  test("a failure that is not the download's own still throws", async () => {
    // The publisher gate's store failing, or a programming error, is
    // not something retrying this one document can fix.
    const failure = new Error("gate unavailable");
    const result = download(async () => {
      throw failure;
    });

    expect(await rejectionOf(result)).toBe(failure);
  });
});

describe("deferred document queue tiers", () => {
  test("both tiers only take decisions that are still waiting", () => {
    for (const predicate of [
      requestedDocumentPredicate,
      remainingDocumentPredicate,
    ]) {
      const { sql } = compileCondition(predicate);

      expect(sql).toContain(`"fulltext" is null`);
      expect(sql).toContain(`"document_url" is not null`);
    }
  });

  test("the priority tier is what a reader asked for, within its retries", () => {
    const { sql, params } = compileCondition(requestedDocumentPredicate);

    expect(sql).toContain(`"document_fetch_requested_at" is not null`);
    expect(sql).toContain(`"document_fetch_attempts" <`);
    expect(params).toContain(MAX_PRIORITY_FETCH_ATTEMPTS);
  });

  test("the remaining tier is everything the priority tier leaves", () => {
    const { sql, params } = compileCondition(remainingDocumentPredicate);

    expect(sql).toContain(`"document_fetch_requested_at" is null`);
    expect(sql).toContain(`"document_fetch_attempts" >=`);
    expect(params).toContain(MAX_PRIORITY_FETCH_ATTEMPTS);
    // The two tiers partition the pending set: the priority tier is
    // "requested and under the retry cap", so its complement has to be
    // an OR of the two negations, or decisions fall out of the queue.
    expect(sql).toContain(" or ");
  });

  test("both tiers leave a just-attempted decision alone", () => {
    // Without this the head of the queue is re-attempted every run and
    // a source refusing those documents starves everything behind them.
    for (const predicate of [
      requestedDocumentPredicate,
      remainingDocumentPredicate,
    ]) {
      const { sql } = compileCondition(predicate);

      expect(sql).toContain(`"document_fetch_attempted_at" is null`);
      expect(sql).toContain(`"document_fetch_attempted_at" < now()`);
    }
  });

  test("requested decisions drain oldest request first", () => {
    expect(compileOrder(requestedDocumentOrder)).toBe(
      `"case_law_decisions"."document_fetch_requested_at" asc, "case_law_decisions"."id" asc`,
    );
  });

  test("the rest drain newest first, undated last", () => {
    expect(compileOrder(remainingDocumentOrder)).toBe(
      `"case_law_decisions"."decision_date" desc nulls last, "case_law_decisions"."id" asc`,
    );
  });

  test("the attempt count orders nothing in the remaining tier", () => {
    // Leading with it partitions the tier: every decision that failed
    // once sorts behind the whole untried backlog, so its retry waits
    // for the backlog rather than for its cooldown. The cooldown in the
    // predicate is what bounds a refused document, asserted above.
    expect(compileOrder(remainingDocumentOrder)).not.toContain(
      "document_fetch_attempts",
    );
  });
});
