import { panic, UnhandledException } from "better-result";
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
  PUBLIC_READ_TIMEOUT_CODE,
  publicReadTimeoutError,
} from "@/api/lib/legal-search/public-read-timeout";
import {
  isSearchIndexUnavailable,
  SEARCH_INDEX_UNAVAILABLE_CODE,
  SEARCH_INDEX_UNAVAILABLE_HINT,
  SEARCH_INDEX_UNAVAILABLE_MESSAGE,
} from "@/api/lib/legal-search/search-index-unavailable";
import {
  findRequestBudgetExpiry,
  runWithinRequestLatencyBudget,
} from "@/api/lib/load/request-latency-budget";
import {
  testAppliedProjectionsFor,
  testRevisionsFor,
} from "@/api/tests/helpers/corpus-projection-revisions";

/**
 * Where "the search index is unavailable" is decided: at the client, from
 * what the request got back. A request no engine answered (refused or reset
 * connection, failed lookup, its own timeout expiring, a body cut off
 * mid-stream) or a gateway answered for (502, 503, 504) is unreachable; an
 * engine answering that it holds no such index (404) is a missing index. Both
 * are unavailable. A request the latency budget of the request being served
 * ended is that request's timeout, never unavailable. An engine that answered
 * with anything else, including bytes this client cannot read, is a failure
 * no retry fixes and stays a generic one.
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
    name: "its own timeout expiring",
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
    projectionRevisionField: "projection_revision",
    extractId: (hit) =>
      typeof hit["document_id"] === "string" ? hit["document_id"] : null,
    extractSnippet: () => null,
    unseenScoreUpperBound: () => 0,
    rankCandidates: async (probes, { selectAppliedCandidates }) => {
      const candidates = selectAppliedCandidates(
        testAppliedProjectionsFor(probes),
      );
      return {
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
        revisionById: testRevisionsFor(candidates),
      };
    },
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
  { type: "scored" },
];

/**
 * An engine that is up but has not answered by the deadline: a cold search,
 * not an outage. Like a real transport it gives up when the request's signal
 * aborts, so only a deadline ends the wait.
 */
const stubSlowEngine = () => {
  globalThis.fetch = Object.assign(
    async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const signal = init?.signal ?? panic("Search requires a timeout signal");
      const answer = Promise.withResolvers<Response>();
      signal.addEventListener(
        "abort",
        () => {
          answer.reject(signal.reason);
        },
        { once: true },
      );
      return await answer.promise;
    },
    { preconnect: originalFetch.preconnect },
  );
};

describe("the request's latency budget is not the index's availability", () => {
  test("a search the budget ends is the budget's expiry, not an outage", async () => {
    stubSlowEngine();

    const result = await runWithinRequestLatencyBudget(
      { label: "search_legislation", budgetMs: 30 },
      searchOnce,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reach).toBe("budget_expired");
      expect(isCorpusIndexUnavailable(result.error)).toBe(false);
      expect(findRequestBudgetExpiry(result.error)).toMatchObject({
        label: "search_legislation",
      });
    }
  });

  test("the search's own timeout with budget left is still unavailable", async () => {
    stubSlowEngine();

    const result = await runWithinRequestLatencyBudget(
      { label: "search_legislation", budgetMs: 8000 },
      async () =>
        await getCorpusIndexClient("q09").search({
          observer: "unobserved",
          indexId: "legal_corpus_v1_cze",
          query: "text:smlouva",
          maxHits: 10,
          timeoutMs: 20, // timeout under test: the search's own, not the budget
        }),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reach).toBe("unreachable");
      expect(isCorpusIndexUnavailable(result.error)).toBe(true);
      expect(findRequestBudgetExpiry(result.error)).toBeUndefined();
    }
  });

  test("a refused connection inside the budget is still unavailable", async () => {
    stubFetch(
      async () =>
        await Promise.reject(
          failureWithCode("connect refused", "ECONNREFUSED"),
        ),
    );

    const result = await runWithinRequestLatencyBudget(
      { label: "search_legislation", budgetMs: 8000 },
      searchOnce,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(isCorpusIndexUnavailable(result.error)).toBe(true);
    }
  });

  test("a caller's abort at the deadline stays the caller's", async () => {
    stubSlowEngine();
    const controller = new AbortController();

    const result = await runWithinRequestLatencyBudget(
      { label: "search_legislation", budgetMs: 8000 },
      async () => {
        const search = getCorpusIndexClient("q09").search({
          observer: "unobserved",
          signal: controller.signal,
          indexId: "legal_corpus_v1_cze",
          query: "text:smlouva",
          maxHits: 10,
        });
        controller.abort(
          new DOMException("The caller gave up.", "TimeoutError"),
        );
        return await search;
      },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reach).not.toBe("budget_expired");
      expect(findRequestBudgetExpiry(result.error)).toBeUndefined();
    }
  });

  test.each(SCAN_TRANSPORTS)(
    "a scan the budget ends throws the public read timeout over the %p transport",
    async (transport) => {
      stubSlowEngine();

      const error = await runWithinRequestLatencyBudget(
        { label: "search_legislation", budgetMs: 30 },
        async () => await scanFailure(transport),
      );

      expect(isSearchIndexUnavailable(error)).toBe(false);
      expect(error).toMatchObject({
        status: 503,
        code: PUBLIC_READ_TIMEOUT_CODE,
      });
      expect(publicReadTimeoutError(error)).toMatchObject({
        code: PUBLIC_READ_TIMEOUT_CODE,
      });
    },
  );
});

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

  test("a request the tool's budget ended reaches a REST route as a timeout", async () => {
    stubSlowEngine();

    const error = await runWithinRequestLatencyBudget(
      { label: "search_legislation", budgetMs: 30 },
      async () => await scanFailure(),
    );
    const wrapped = new UnhandledException({ cause: error });

    // The route reads the public read timeout first, then the handler error.
    expect(
      publicReadTimeoutError(wrapped) ?? resolveHandlerError(wrapped),
    ).toMatchObject({ status: 503, code: PUBLIC_READ_TIMEOUT_CODE });
    expect(resolveHandlerError(wrapped)?.code).toBe(PUBLIC_READ_TIMEOUT_CODE);
    expect(isSearchIndexUnavailable(wrapped)).toBe(false);
  });

  test("a bug that is not the index stays generic", () => {
    expect(
      isSearchIndexUnavailable(new Error("undefined is not a function")),
    ).toBe(false);
    expect(
      isSearchIndexUnavailable(
        new HandlerError({
          status: 503,
          code: "internal_error",
          message: "Search is temporarily unavailable",
        }),
      ),
    ).toBe(false);
  });
});
