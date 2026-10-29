import { QueryClient } from "@tanstack/react-query";
import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";

import { APIError } from "@/lib/errors/api";

import {
  documentPropertiesOptions,
  saveEmailAttachment,
  updateDocumentProperty,
} from "./queries";

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
      await client.query(
        documentPropertiesOptions({
          fieldId: "00000000-0000-4000-8000-000000000002",
          workspaceId: "00000000-0000-4000-8000-000000000001",
        }),
      ),
  );
});

test("file writes keep their 60 second request bound", async () => {
  const timeouts = spyOn(AbortSignal, "timeout");
  try {
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
    await updateDocumentProperty({
      fieldId: "00000000-0000-4000-8000-000000000002",
      propertyKey: "title",
      value: "Draft agreement",
      workspaceId: "00000000-0000-4000-8000-000000000001",
    });
    expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([60_000, 60_000]);
  } finally {
    timeouts.mockRestore();
  }
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
