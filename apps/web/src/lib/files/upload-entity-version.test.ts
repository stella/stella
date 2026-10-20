import { afterEach, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { uploadEntityVersion } from "./upload-entity-version";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const installUploadTransport = (
  finalizeStatus: (attempt: number) => number,
) => {
  const calls: { method: string; url: string }[] = [];
  let finalizeAttempts = 0;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      calls.push({ method: request.method, url: request.url });
      if (request.url === "https://storage.example/version") {
        return new Response(null, { status: 200 });
      }
      if (request.url.includes("/presign")) {
        return Response.json({
          uploadId: "22222222-2222-4222-8222-222222222222",
          url: "https://storage.example/version",
          headers: {},
        });
      }
      if (request.url.includes("/finalize")) {
        finalizeAttempts += 1;
        const status = finalizeStatus(finalizeAttempts);
        return status === 200
          ? Response.json({
              finalizedResult: {
                type: "entity_version",
                entityId: "33333333-3333-4333-8333-333333333333",
                versionId: "version-1",
              },
            })
          : Response.json(
              { message: "Upload processing is busy; retry shortly" },
              { status, headers: { "Retry-After": "1" } },
            );
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  return calls;
};

const upload = async (
  onFinalizeBusy?: (
    event: { retryAfterS: number; attempt: number } | null,
  ) => void,
) =>
  await uploadEntityVersion({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    entityId: "33333333-3333-4333-8333-333333333333",
    file: new File(["version"], "version.txt", { type: "text/plain" }),
    onFinalizeBusy,
    finalizeWait: async () => {},
  });

const uploadCallCounts = (calls: { method: string; url: string }[]) => ({
  presign: calls.filter(({ url }) => url.includes("/presign")).length,
  put: calls.filter(
    ({ method, url }) =>
      method === "PUT" && url === "https://storage.example/version",
  ).length,
  finalize: calls.filter(({ url }) => url.includes("/finalize")).length,
});

test("retries only finalization after a refusal and reports the wait", async () => {
  const calls = installUploadTransport((attempt) =>
    attempt === 1 ? 503 : 200,
  );
  const busy: { retryAfterS: number; attempt: number }[] = [];
  await upload((event) => {
    if (event !== null) {
      busy.push(event);
    }
  });

  expect(uploadCallCounts(calls)).toEqual({ presign: 1, put: 1, finalize: 2 });
  const finalizeUrls = calls
    .filter(({ url }) => url.includes("/finalize"))
    .map(({ url }) => url);
  expect(new Set(finalizeUrls).size).toBe(1);
  expect(busy).toEqual([{ retryAfterS: 1, attempt: 1 }]);
});

test("stops at the shared bound and surfaces the final refusal", async () => {
  const calls = installUploadTransport(() => 503);
  expect(await rejectionOf(upload())).toHaveProperty(
    "message",
    expect.stringContaining("temporarily unavailable"),
  );
  expect(uploadCallCounts(calls)).toEqual({ presign: 1, put: 1, finalize: 5 });
});
