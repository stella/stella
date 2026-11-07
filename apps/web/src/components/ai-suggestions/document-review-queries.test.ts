import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { waitFor } from "@stll/test-kit";

import { APIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { docxSuggestionsOptions } from "@/lib/workspaces/queries/docx-suggestions";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("cached and detect reads stay separate, reuse detection, and do not retry failures", async () => {
  const requestBodies: unknown[] = [];
  const fetchMock = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requestBodies.push(await request.json());
      if (requestBodies.length >= 3) {
        return Response.json({ message: "Unavailable" }, { status: 503 });
      }
      return requestBodies.length === 1
        ? Response.json({
            type: "not-detected",
            entityVersionId: "version-A",
          })
        : Response.json({
            type: "cached",
            entityVersionId: "version-A",
            parties: [{ role: "Buyer", name: "Buyer Ltd." }],
          });
    },
  );
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  });

  const { documentReviewPartiesOptions } =
    await import("./document-review-queries");
  const queryClient = new QueryClient();
  const target = {
    workspaceId: "matter",
    entityId: "document",
    fileFieldId: "file",
  };

  const cachedAnswer = await queryClient.query(
    documentReviewPartiesOptions(target, "cached"),
  );
  expect(cachedAnswer.type).toBe("not-detected");
  expect(requestBodies).toEqual([
    {
      mode: "cached",
      target: { entityId: "document", fileFieldId: "file" },
    },
  ]);

  const detectedAnswer = await queryClient.query(
    documentReviewPartiesOptions(target, "detect"),
  );
  expect(detectedAnswer.type).toBe("cached");
  expect(
    detectedAnswer.type === "cached" ? detectedAnswer.parties : [],
  ).toEqual([{ role: "Buyer", name: "Buyer Ltd." }]);
  await queryClient.query(documentReviewPartiesOptions(target, "detect"));

  expect(requestBodies).toHaveLength(2);
  expect(requestBodies.at(1)).toEqual({
    mode: "detect",
    target: { entityId: "document", fileFieldId: "file" },
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);

  const failedDetection = await queryClient
    .query(
      documentReviewPartiesOptions(
        { ...target, entityId: "document-with-error" },
        "detect",
      ),
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(failedDetection).toBeInstanceOf(APIError);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(requestBodies.at(2)).toEqual({
    mode: "detect",
    target: {
      entityId: "document-with-error",
      fileFieldId: "file",
    },
  });
  queryClient.clear();
});

test("the launcher reuses a positive cached read and still detects after not-detected", async () => {
  const requestBodies: unknown[] = [];
  const fetchMock = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const body: unknown = await request.json();
      requestBodies.push(body);
      const isPositiveTarget = JSON.stringify(body).includes('"cached-doc"');
      return isPositiveTarget
        ? Response.json({
            type: "cached",
            entityVersionId: "version-A",
            parties: [{ role: "Seller", name: "Seller Ltd." }],
          })
        : Response.json({ type: "not-detected", entityVersionId: "version-B" });
    },
  );
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  });

  const { documentReviewPartiesDetectOptions, documentReviewPartiesOptions } =
    await import("./document-review-queries");
  const queryClient = new QueryClient();
  const positive = {
    workspaceId: "matter",
    entityId: "cached-doc",
    fileFieldId: "file",
  };
  const negative = { ...positive, entityId: "fresh-doc" };

  await queryClient.query(documentReviewPartiesOptions(positive, "cached"));
  await queryClient.query(documentReviewPartiesOptions(negative, "cached"));
  expect(requestBodies).toHaveLength(2);

  const reused = await queryClient.query(
    documentReviewPartiesDetectOptions(positive, queryClient),
  );
  expect(reused.type).toBe("cached");
  expect(String(reused.entityVersionId)).toBe("version-A");
  expect(reused.type === "cached" ? reused.parties : []).toEqual([
    { role: "Seller", name: "Seller Ltd." },
  ]);
  expect(requestBodies).toHaveLength(2);

  await queryClient.query(
    documentReviewPartiesDetectOptions(negative, queryClient),
  );
  expect(requestBodies).toHaveLength(3);
  expect(requestBodies.at(2)).toEqual({
    mode: "detect",
    target: { entityId: "fresh-doc", fileFieldId: "file" },
  });
  queryClient.clear();
});

const reviewedDocument = {
  workspaceId: "matter",
  entityId: "reviewed-doc",
  fileFieldId: "file",
};
const REVIEW_RUN_ID = "run-1";

const reviewRunDetail = (status: string) => ({
  run: {
    id: REVIEW_RUN_ID,
    status,
    entityId: reviewedDocument.entityId,
  },
  findings: [],
});

type ReviewedDocumentServer = {
  runStatus: string;
  suggestionIds: string[];
  suggestionReads: () => number;
};

const serveReviewedDocument = (
  runStatus: string,
  suggestionIds: string[] = [],
): ReviewedDocumentServer => {
  let suggestionReads = 0;
  const server: ReviewedDocumentServer = {
    runStatus,
    suggestionIds,
    suggestionReads: () => suggestionReads,
  };
  const fetchMock = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const { url } = new Request(input, init);
      const { pathname } = new URL(url);
      if (pathname.includes("docx-suggestions")) {
        suggestionReads += 1;
        return Response.json({
          items: server.suggestionIds.map((id) => ({
            id,
            createdAt: "2026-11-07T16:04:24.000Z",
          })),
          nextCursor: null,
        });
      }
      const detail = reviewRunDetail(server.runStatus);
      return Response.json(
        pathname.endsWith(`/runs/${REVIEW_RUN_ID}`)
          ? detail
          : { items: [], latest: detail, nextCursor: null },
      );
    },
  );
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  });
  return server;
};

const pollRun = async (queryClient: QueryClient) => {
  const { documentReviewRunOptions } =
    await import("./document-review-queries");
  await queryClient.query({
    ...documentReviewRunOptions({
      workspaceId: reviewedDocument.workspaceId,
      runId: REVIEW_RUN_ID,
    }),
    staleTime: 0,
  });
};

const readRunHistory = async (queryClient: QueryClient) => {
  const { documentReviewRunsOptions } =
    await import("./document-review-queries");
  await queryClient.query(documentReviewRunsOptions(reviewedDocument));
};

const observeSuggestions = (queryClient: QueryClient) => {
  const observer = new QueryObserver(
    queryClient,
    docxSuggestionsOptions(reviewedDocument),
  );
  const unsubscribe = observer.subscribe(() => undefined);
  const loadedIds = async (expectedLength: number) =>
    await waitFor(
      () => {
        const { data, isFetching } = observer.getCurrentResult();
        const ids = data?.items.map(({ id }) => id);
        return !isFetching && ids?.length === expectedLength ? ids : undefined;
      },
      { description: `${expectedLength} loaded suggestions` },
    );
  return { loadedIds, unsubscribe };
};

const READ_RUN = { poll: pollRun, history: readRunHistory };

describe.each(Object.entries(READ_RUN))(
  "the pending suggestion list when a run is read by %s",
  (_name, readRun) => {
    test("loads the changes a run staged once the run completes", async () => {
      const server = serveReviewedDocument("running");
      const queryClient = new QueryClient();
      await pollRun(queryClient);
      const suggestions = observeSuggestions(queryClient);
      expect(await suggestions.loadedIds(0)).toEqual([]);

      server.runStatus = "completed";
      server.suggestionIds = ["staged-by-run"];
      await readRun(queryClient);

      expect(await suggestions.loadedIds(1)).toEqual([
        toSafeId("staged-by-run"),
      ]);
      suggestions.unsubscribe();
      queryClient.clear();
    });

    test("stays as it is for a run that was already completed", async () => {
      const server = serveReviewedDocument("completed");
      const queryClient = new QueryClient();
      const suggestions = observeSuggestions(queryClient);
      await suggestions.loadedIds(0);

      await readRun(queryClient);
      await readRun(queryClient);
      await suggestions.loadedIds(0);

      expect(server.suggestionReads()).toBe(1);
      suggestions.unsubscribe();
      queryClient.clear();
    });

    test("stays as it is for a run that failed", async () => {
      const server = serveReviewedDocument("running");
      const queryClient = new QueryClient();
      await pollRun(queryClient);
      const suggestions = observeSuggestions(queryClient);
      await suggestions.loadedIds(0);

      server.runStatus = "failed";
      await readRun(queryClient);
      await suggestions.loadedIds(0);

      expect(server.suggestionReads()).toBe(1);
      suggestions.unsubscribe();
      queryClient.clear();
    });
  },
);

test("the pending suggestion list refreshes when the run detail was evicted before the run completed", async () => {
  const { documentReviewRunOptions } =
    await import("./document-review-queries");
  const server = serveReviewedDocument("running");
  const queryClient = new QueryClient();
  await pollRun(queryClient);
  const suggestions = observeSuggestions(queryClient);
  await suggestions.loadedIds(0);

  // The reviewer closes the review while the document stays open.
  queryClient.removeQueries({
    queryKey: documentReviewRunOptions({
      workspaceId: reviewedDocument.workspaceId,
      runId: REVIEW_RUN_ID,
    }).queryKey,
    exact: true,
  });
  server.runStatus = "completed";
  server.suggestionIds = ["staged-by-run"];
  await pollRun(queryClient);

  expect(await suggestions.loadedIds(1)).toEqual([toSafeId("staged-by-run")]);
  suggestions.unsubscribe();
  queryClient.clear();
});

test("the pending suggestion list refreshes once when both reads report the same completion", async () => {
  const server = serveReviewedDocument("running");
  const queryClient = new QueryClient();
  await pollRun(queryClient);
  const suggestions = observeSuggestions(queryClient);
  await suggestions.loadedIds(0);

  server.runStatus = "completed";
  server.suggestionIds = ["staged-by-run"];
  await Promise.all([pollRun(queryClient), readRunHistory(queryClient)]);

  expect(await suggestions.loadedIds(1)).toEqual([toSafeId("staged-by-run")]);
  expect(server.suggestionReads()).toBe(2);
  suggestions.unsubscribe();
  queryClient.clear();
});
