import { afterEach, expect, test } from "bun:test";

import { UploadQueue } from "@/lib/upload-queue";
import { uploadFileEntity } from "@/lib/workspaces/mutations/use-create-file-entities";

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
      if (request.url === "https://storage.example/upload") {
        return new Response(null, { status: 200 });
      }
      if (request.url.includes("/presign")) {
        return Response.json({
          uploadId: "22222222-2222-4222-8222-222222222222",
          url: "https://storage.example/upload",
          headers: {},
        });
      }
      if (request.url.includes("/finalize")) {
        finalizeAttempts += 1;
        const status = finalizeStatus(finalizeAttempts);
        return status === 200
          ? Response.json({
              finalizedResult: {
                type: "entity_create",
                entityId: "entity-1",
                fileId: "file-1",
                fileName: "contract.txt",
                renamed: false,
              },
            })
          : Response.json(
              { message: "Upload processing is busy; retry shortly" },
              { status, headers: { "Retry-After": "1" } },
            );
      }
      if (request.url.includes("/abort")) {
        return Response.json({ aborted: true });
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
  await uploadFileEntity({
    file: new File(["contract"], "contract.txt", { type: "text/plain" }),
    workspaceId: "11111111-1111-4111-8111-111111111111",
    propertyId: "33333333-3333-4333-8333-333333333333",
    signal: new AbortController().signal,
    onFinalizeBusy,
    finalizeWait: async () => {},
  });

const uploadCallCounts = (calls: { method: string; url: string }[]) => ({
  abort: calls.filter(({ url }) => url.includes("/abort")).length,
  presign: calls.filter(({ url }) => url.includes("/presign")).length,
  put: calls.filter(
    ({ method, url }) =>
      method === "PUT" && url === "https://storage.example/upload",
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

  expect(uploadCallCounts(calls)).toEqual({
    abort: 0,
    presign: 1,
    put: 1,
    finalize: 2,
  });
  const finalizeUrls = calls
    .filter(({ url }) => url.includes("/finalize"))
    .map(({ url }) => url);
  expect(new Set(finalizeUrls).size).toBe(1);
  expect(busy).toEqual([{ retryAfterS: 1, attempt: 1 }]);
});

test("an exhausted refusal aborts once and is terminal to the upload queue", async () => {
  const calls = installUploadTransport(() => 503);
  const file = new File(["contract"], "contract.txt", { type: "text/plain" });
  const queue = new UploadQueue(
    async (_file, signal, reportFinalizeBusy) =>
      await uploadFileEntity({
        file,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        propertyId: "33333333-3333-4333-8333-333333333333",
        signal,
        onFinalizeBusy: reportFinalizeBusy,
        finalizeWait: async () => {},
      }),
  );
  const done = new Promise<void>((resolve) => {
    queue.on("done", () => resolve());
  });

  queue.enqueue([file]);
  await done;

  expect(queue.getProgress()).toEqual({ completed: 0, failed: 1, total: 1 });
  expect(queue.getFailedFiles().at(0)?.error).toHaveProperty(
    "message",
    expect.stringContaining("temporarily unavailable"),
  );
  expect(uploadCallCounts(calls)).toEqual({
    abort: 1,
    presign: 1,
    put: 1,
    finalize: 5,
  });
});
