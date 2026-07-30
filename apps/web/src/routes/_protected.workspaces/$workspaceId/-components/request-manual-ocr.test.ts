import { Result } from "better-result";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { requestManualOcr } from "./request-manual-ocr";

const originalFetch = globalThis.fetch;
type FetchHandler = (
  ...args: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("requestManualOcr", () => {
  test("posts the source field and validates the queued response", async () => {
    const fetchMock = setFetch(async () =>
      Response.json({ outcome: "queued", runId: "run_1" }),
    );

    const result = await requestManualOcr({
      entityId: "entity_1",
      fieldId: "field_1",
      workspaceId: "workspace_1",
    });

    expect(result).toEqual({ outcome: "queued", runId: "run_1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls.at(0) ?? [];
    expect(url).toBe(
      "http://localhost:3001/v1/entities/workspace_1/entity/entity_1/ocr",
    );
    expect(init).toMatchObject({
      body: JSON.stringify({ fieldId: "field_1" }),
      credentials: "include",
      method: "POST",
    });
  });

  test("maps HTTP failures to an API error", async () => {
    setFetch(async () => new Response(null, { status: 409 }));

    const result = await Result.tryPromise({
      try: async () =>
        await requestManualOcr({
          entityId: "entity_1",
          fieldId: "field_1",
          workspaceId: "workspace_1",
        }),
      catch: (cause) => cause,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ _tag: "ApiError", status: 409 });
    }
  });

  test("rejects malformed success payloads", async () => {
    setFetch(async () => Response.json({ outcome: "queued", runId: null }));

    const result = await Result.tryPromise({
      try: async () =>
        await requestManualOcr({
          entityId: "entity_1",
          fieldId: "field_1",
          workspaceId: "workspace_1",
        }),
      catch: (cause) => cause,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ _tag: "ApiError", status: 502 });
    }
  });
});

const setFetch = (handler: FetchHandler) => {
  const fetchMock = mock(handler);
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  });
  return fetchMock;
};
