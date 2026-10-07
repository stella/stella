import { UnhandledException } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { envBase } from "@/api/env-base";
import { resolveHandlerError } from "@/api/lib/errors/handler-error-resolution";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  getCorpusIndexClient,
  isCorpusIndexUnavailable,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  type CorpusIndexScanTransport,
  NATIVE_SCAN_TRANSPORT,
  readCorpusIndexSearchPage,
} from "@/api/lib/legal-search/corpus-index-pagination";
import { corpusSearchGroupToken } from "@/api/lib/legal-search/corpus-search-cursor";
import { RELEVANCE_ORDER } from "@/api/lib/legal-search/corpus-search-order";
import {
  isSearchIndexUnavailable,
  SEARCH_INDEX_UNAVAILABLE_CODE,
  SEARCH_INDEX_UNAVAILABLE_HINT,
  SEARCH_INDEX_UNAVAILABLE_MESSAGE,
} from "@/api/lib/legal-search/search-index-unavailable";

/**
 * Where "the search index is unavailable" is decided: at the client, from
 * what the request got back. A request no engine answered (refused or reset
 * connection, failed lookup, expired budget, a body cut off mid-stream) or a
 * gateway answered for (502, 503, 504) is unreachable; an engine answering
 * that it holds no such index (404) is a missing index. Both are unavailable.
 * An engine that answered with anything else, including bytes this client
 * cannot read, is a failure no retry fixes and stays a generic one.
 */

const originalFetch = globalThis.fetch;
const originalSearchEndpoint = envBase.CORPUS_INDEX_Q09_SEARCH_ENDPOINT;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(envBase, {
    CORPUS_INDEX_Q09_SEARCH_ENDPOINT: originalSearchEndpoint,
  });
});

const stubFetch = (answer: () => Promise<Response>) => {
  globalThis.fetch = Object.assign(answer, {
    preconnect: originalFetch.preconnect,
  });
};

const failureWithCode = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code });

const cutOffBody = (): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"num_hits":'));
        controller.error(failureWithCode("socket closed", "ECONNRESET"));
      },
    }),
    { status: 200 },
  );

type FailureShape = {
  name: string;
  answer: () => Promise<Response>;
};

const UNREACHABLE: readonly FailureShape[] = [
  {
    name: "connection reset",
    answer: async () =>
      await Promise.reject(failureWithCode("socket hang up", "ECONNRESET")),
  },
  {
    name: "DNS lookup failure",
    answer: async () =>
      await Promise.reject(
        failureWithCode("getaddrinfo ENOTFOUND quickwit", "ENOTFOUND"),
      ),
  },
  {
    name: "expired budget",
    answer: async () =>
      await Promise.reject(
        new DOMException("The operation timed out.", "TimeoutError"),
      ),
  },
  {
    name: "body cut off mid-stream",
    answer: async () => await Promise.resolve(cutOffBody()),
  },
  ...[502, 503, 504].map((status) => ({
    name: `gateway ${status}`,
    answer: async () =>
      await Promise.resolve(new Response("no healthy upstream", { status })),
  })),
];

/** The bodies the engine answers a search naming an absent index with. */
const INDEX_MISSING: readonly FailureShape[] = [
  {
    name: "native search of a missing index",
    answer: async () =>
      await Promise.resolve(
        Response.json(
          {
            message:
              'could not find indexes matching the IDs `["legal_corpus_v1_cze"]`',
          },
          { status: 404 },
        ),
      ),
  },
  {
    name: "Elasticsearch-compatible search of a missing index",
    answer: async () =>
      await Promise.resolve(
        Response.json(
          {
            error: {
              type: "index_not_found_exception",
              reason: "no such index [legal_corpus_v1_cze]",
            },
            status: 404,
          },
          { status: 404 },
        ),
      ),
  },
];

const UNAVAILABLE: readonly FailureShape[] = [...UNREACHABLE, ...INDEX_MISSING];

const ANSWERED: readonly FailureShape[] = [
  ...[400, 429, 500].map((status) => ({
    name: `engine ${status}`,
    answer: async () =>
      await Promise.resolve(new Response("refused", { status })),
  })),
  {
    name: "unparseable body",
    answer: async () =>
      await Promise.resolve(new Response("not json", { status: 200 })),
  },
  {
    name: "body of the wrong shape",
    answer: async () =>
      await Promise.resolve(Response.json({ error: "index missing" })),
  },
];

const searchOnce = async () =>
  await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    maxHits: 10,
  });

const readPage = async (scanTransport: CorpusIndexScanTransport) =>
  await readCorpusIndexSearchPage({
    observer: "unobserved",
    cluster: "q09",
    indexId: "legal_corpus_v1_cze",
    query: "text:smlouva",
    limit: 10,
    order: RELEVANCE_ORDER,
    parsedCursor: null,
    scanTransport,
    snippetFields: ["text"],
    extractId: (hit) =>
      typeof hit["document_id"] === "string" ? hit["document_id"] : null,
    extractSnippet: () => null,
    unseenScoreUpperBound: () => 0,
    rankCandidates: async (candidates) =>
      await Promise.resolve({
        context: null,
        groups: candidates.map((candidate) =>
          corpusSearchGroupToken(candidate.id),
        ),
        ranked: candidates.map((candidate) => ({
          id: candidate.id,
          score: candidate.score,
          lexicalScore: candidate.score,
          citationAuthority: 0,
        })),
      }),
  });

/** What a scan threw, or a failure of the test when it threw nothing. */
const scanFailure = async (
  scanTransport: CorpusIndexScanTransport = NATIVE_SCAN_TRANSPORT,
): Promise<unknown> => {
  const outcome = await readPage(scanTransport).then(
    () => null,
    (error: unknown) => ({ error }),
  );
  if (outcome === null) {
    throw new Error("the scan succeeded against a failing engine");
  }
  return outcome.error;
};

describe("the client reads an unavailable index from the request", () => {
  test("a refused connection to a real closed port", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    // Read before the stop: the address is the one nothing listens on after.
    const closedOrigin = server.url.origin;
    await server.stop(true);
    Object.assign(envBase, {
      CORPUS_INDEX_Q09_SEARCH_ENDPOINT: closedOrigin,
    });

    const result = await searchOnce();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(isCorpusIndexUnavailable(result.error)).toBe(true);
    }
  });

  for (const shape of UNAVAILABLE) {
    test(`${shape.name} is unavailable`, async () => {
      stubFetch(shape.answer);

      const result = await searchOnce();

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(isCorpusIndexUnavailable(result.error)).toBe(true);
      }
    });
  }

  for (const shape of ANSWERED) {
    test(`${shape.name} is an answer, not an outage`, async () => {
      stubFetch(shape.answer);

      const result = await searchOnce();

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(isCorpusIndexUnavailable(result.error)).toBe(false);
      }
    });
  }
});

const SCAN_TRANSPORTS: readonly CorpusIndexScanTransport[] = [
  NATIVE_SCAN_TRANSPORT,
  { type: "scored", fields: ["document_id"] },
];

describe("a scan answers an unavailable index with the typed refusal", () => {
  for (const shape of UNAVAILABLE) {
    test.each(SCAN_TRANSPORTS)(
      `${shape.name} throws a retryable 503 search_index_unavailable over the %p transport`,
      async (transport) => {
        stubFetch(shape.answer);

        const error = await scanFailure(transport);

        expect(HandlerError.is(error)).toBe(true);
        expect(isSearchIndexUnavailable(error)).toBe(true);
        expect(error).toMatchObject({
          status: 503,
          code: SEARCH_INDEX_UNAVAILABLE_CODE,
          message: SEARCH_INDEX_UNAVAILABLE_MESSAGE,
          hint: SEARCH_INDEX_UNAVAILABLE_HINT,
          retryable: true,
        });
      },
    );
  }

  for (const shape of ANSWERED) {
    test(`${shape.name} stays an untyped failure`, async () => {
      stubFetch(shape.answer);

      const error = await scanFailure();

      expect(HandlerError.is(error)).toBe(true);
      expect(isSearchIndexUnavailable(error)).toBe(false);
    });
  }

  test("the refusal survives the wrapper a REST route receives it in", async () => {
    stubFetch(
      async () =>
        await Promise.reject(
          failureWithCode("connect refused", "ECONNREFUSED"),
        ),
    );

    const error = await scanFailure();
    const wrapped = new UnhandledException({ cause: error });

    // The safe-handler boundary answers with the status and body of the
    // HandlerError it resolves, so the route answers 503 with the code.
    expect(isSearchIndexUnavailable(wrapped)).toBe(true);
    expect(resolveHandlerError(wrapped)).toMatchObject({
      status: 503,
      code: SEARCH_INDEX_UNAVAILABLE_CODE,
      retryable: true,
    });
  });

  test("a bug that is not the index stays generic", () => {
    expect(
      isSearchIndexUnavailable(new Error("undefined is not a function")),
    ).toBe(false);
    expect(
      isSearchIndexUnavailable(
        new HandlerError({
          status: 503,
          message: "Search is temporarily unavailable",
        }),
      ),
    ).toBe(false);
  });
});
