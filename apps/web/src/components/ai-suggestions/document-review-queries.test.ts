import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, mock, test } from "bun:test";

import { APIError } from "@/lib/errors/api";

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
  expect(reused).toEqual({
    type: "cached",
    entityVersionId: "version-A",
    parties: [{ role: "Seller", name: "Seller Ltd." }],
  });
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
