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
  MAX_DOCUMENT_PDF_BYTES,
  MAX_PRIORITY_FETCH_ATTEMPTS,
  parkedDocumentPredicate,
  type PdfFetchResult,
  remainingDocumentOrder,
  remainingDocumentPredicate,
  requestedDocumentOrder,
  requestedDocumentPredicate,
} from "@/api/lib/legal-search/sk-document-backfill";
import { readOfResponse } from "@/api/tests/helpers/publisher-read";

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
    // The parked threshold is a literal, not a parameter: it has to match
    // the parked index's predicate under a generic plan too.
    const parked = compileCondition(parkedDocumentPredicate);
    expect(parked.sql).toContain(
      `"document_fetch_attempts" >= ${MAX_DOCUMENT_FETCH_ATTEMPTS}`,
    );
    expect(parked.params).not.toContain(MAX_DOCUMENT_FETCH_ATTEMPTS);
  });
});

const PUBLISHER_URL =
  "https://obcan.justice.sk/content/public/item/6fe03973-7694-432b-9ebd-dfa4104ef742";

/** One download through a gate that answers with what `respond` serves. */
const download = async (
  respond: () => Promise<Response>,
): Promise<PdfFetchResult> =>
  await fetchPdfBytes({
    documentUrl: PUBLISHER_URL,
    fetchDocument: async () => readOfResponse(await respond()),
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

/** A body that errors after its first bytes, as a dropped download does. */
const brokenBody = (error: unknown): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new Uint8Array([0x25, 0x50]));
      controller.error(error);
    },
  });

/**
 * Statuses that answer for the publisher or this client, not for the one
 * document requested: every 5xx, credentials, a refused client, and a
 * request for less traffic.
 */
const isPublisherWideStatus = (status: number): boolean =>
  status >= 500 || [401, 403, 407, 408, 429].includes(status);

describe("one document's download", () => {
  test("no status is the document's own failure unless it is a client error about the request", async () => {
    // A throw backs the whole walk off; a `failed` result costs only this
    // document's attempt. Swept over every status a response can carry, so
    // an outage (5xx) or a refused client can never spend the attempts of
    // every document it touches.
    for (let status = 300; status < 600; status += 1) {
      const outcome = await rejectionOf(
        download(
          async () => await Promise.resolve(new Response(null, { status })),
        ),
      );

      if (status === 404 || status === 410) {
        expect({ status, outcome }).toEqual({
          status,
          outcome: { resolved: { type: "absent" } },
        });
        continue;
      }
      if (status >= 400 && !isPublisherWideStatus(status)) {
        expect({ status, outcome }).toEqual({
          status,
          outcome: {
            resolved: {
              type: "failed",
              failure: DOCUMENT_FETCH_FAILURE.PUBLISHER_STATUS,
              detail: `http-${status}`,
            },
          },
        });
        continue;
      }
      expect({ status, thrown: outcome instanceof AdapterFetchError }).toEqual({
        status,
        thrown: true,
      });
    }
  });

  test("an empty 204 is that document's own failure, not an empty document", async () => {
    const result = await download(
      async () => await Promise.resolve(new Response(null, { status: 204 })),
    );

    expect(result).toEqual({
      type: "failed",
      failure: DOCUMENT_FETCH_FAILURE.PUBLISHER_STATUS,
      detail: "http-204",
    });
  });

  test("a URL the gate refuses is nothing to fetch", async () => {
    const result = await fetchPdfBytes({
      documentUrl: PUBLISHER_URL,
      fetchDocument: async () =>
        await Promise.resolve({
          type: "refused-target" as const,
          reason: "off the publisher's hosts",
        }),
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ type: "absent" });
  });

  test("not found and gone mean there is nothing to fetch", async () => {
    for (const status of [404, 410]) {
      const result = await download(
        async () => await Promise.resolve(new Response(null, { status })),
      );

      expect(result).toEqual({ type: "absent" });
    }
  });

  test("a download that never got an answer throws, so the walk backs off", async () => {
    // Refused, reset, redirected or timed out before a response: the
    // publisher's state, not the document's, as far as this download can
    // tell. The gate's own failure throws the same way.
    for (const failure of [
      bunNetworkError("ECONNRESET"),
      bunNetworkError("ConnectionRefused"),
      bunNetworkError("UnexpectedRedirect"),
      new DOMException("The operation timed out.", "TimeoutError"),
      new Error("gate unavailable"),
    ]) {
      const result = download(async () => {
        throw failure;
      });

      expect(await rejectionOf(result)).toBe(failure);
    }
  });

  test("a body cut off mid-download is that document's own failure", async () => {
    const result = await download(
      async () =>
        await Promise.resolve(
          new Response(brokenBody(bunNetworkError("ECONNRESET"))),
        ),
    );

    expect(result).toEqual({
      type: "failed",
      failure: DOCUMENT_FETCH_FAILURE.NETWORK,
      detail: "TypeError:ECONNRESET",
    });
  });

  test("a body that runs out of time is that document's own failure", async () => {
    const result = await download(
      async () =>
        await Promise.resolve(
          new Response(
            brokenBody(
              new DOMException("The operation timed out.", "TimeoutError"),
            ),
          ),
        ),
    );

    expect(result).toEqual({
      type: "failed",
      failure: DOCUMENT_FETCH_FAILURE.NETWORK,
      detail: "TimeoutError",
    });
  });

  test("a body over the byte ceiling is refused typed, without reading it to the end", async () => {
    const chunkBytes = 1024 * 1024;
    const servedBytes = MAX_DOCUMENT_PDF_BYTES + 8 * chunkBytes;
    let pulledBytes = 0;
    const oversized = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (pulledBytes >= servedBytes) {
          controller.close();
          return;
        }
        pulledBytes += chunkBytes;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
    });

    const result = await download(
      async () => await Promise.resolve(new Response(oversized)),
    );

    expect(result).toMatchObject({
      type: "too-large",
      limitBytes: MAX_DOCUMENT_PDF_BYTES,
    });
    expect(
      result.type === "too-large" ? result.prefix?.byteLength : undefined,
    ).toBe(1024);
    expect(pulledBytes).toBeLessThan(servedBytes);
  });

  test("a body at the byte ceiling is the document", async () => {
    const result = await download(
      async () =>
        await Promise.resolve(
          new Response(new Uint8Array(MAX_DOCUMENT_PDF_BYTES)),
        ),
    );

    expect(result.type === "document" ? result.bytes.byteLength : 0).toBe(
      MAX_DOCUMENT_PDF_BYTES,
    );
  });

  test("a body failure that is not the download's own still throws", async () => {
    // An abort on drain, or a programming error, is not something
    // retrying this one document can fix.
    const failure = new Error("stream consumer failed");
    const result = download(
      async () => await Promise.resolve(new Response(brokenBody(failure))),
    );

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

      expect(sql.toLowerCase()).toContain(`"fulltext" is null`);
      expect(sql.toLowerCase()).toContain(`"document_url" is not null`);
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
