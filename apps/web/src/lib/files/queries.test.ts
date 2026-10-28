import { QueryClient } from "@tanstack/react-query";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

import { APIError } from "@/lib/errors/api";

import { documentPropertiesOptions, saveEmailAttachment } from "./queries";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = Object.assign(
    mock(
      async () =>
        new Response("{}", {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    ),
    { preconnect: originalFetch.preconnect },
  );
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const expectBadGateway = async (call: () => Promise<unknown>) => {
  try {
    await call();
    throw new Error("Expected the empty success answer to be rejected");
  } catch (error) {
    expect(error).toBeInstanceOf(APIError);
    expect(error).toMatchObject({ status: 502 });
  }
};

test("an empty document properties answer is a bad gateway", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await expectBadGateway(
    async () =>
      await client.fetchQuery(
        documentPropertiesOptions({
          fieldId: "00000000-0000-4000-8000-000000000002",
          workspaceId: "00000000-0000-4000-8000-000000000001",
        }),
      ),
  );
});

test("an empty email attachment save answer is a bad gateway", async () => {
  await expectBadGateway(
    async () =>
      await saveEmailAttachment({
        attachmentId: "attachment-1",
        destinationWorkspaceId: "00000000-0000-4000-8000-000000000003",
        fieldId: "00000000-0000-4000-8000-000000000002",
        parentId: null,
        sourceWorkspaceId: "00000000-0000-4000-8000-000000000001",
      }),
  );
});
