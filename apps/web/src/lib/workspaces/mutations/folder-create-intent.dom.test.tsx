import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { act, cleanup, renderHook } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { useCreateFolderFromSelection } = await import("./entities");
const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(unregisterDomEnvironment);

test("folder selection retries preserve both the submit intent and capability", async () => {
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return requests.length === 1
        ? Response.json({ message: "Unavailable" }, { status: 503 })
        : Response.json({ entityId: "00000000-0000-4000-8000-000000000003" });
    },
    { preconnect: originalFetch.preconnect },
  );
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: 1, retryDelay: 0 } },
  });
  const { result } = renderHook(useCreateFolderFromSelection, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  const variables = {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    name: "Correspondence",
    parentId: null,
    entityIds: ["00000000-0000-4000-8000-000000000002"],
  };
  await act(async () => {
    await result.current.mutateAsync(variables);
  });
  expect(requests).toHaveLength(2);
  const keys = requests.map((request) =>
    request.headers.get("Idempotency-Key"),
  );
  expect(keys.at(0)).toBeString();
  expect(keys.at(1)).toBe(keys.at(0));
  for (const request of requests) {
    expect(request.headers.get(CAPABILITY_REQUEST_HEADER)).toBe(
      "entities.folder-from-selection.create",
    );
  }
  await act(async () => {
    await result.current.mutateAsync(variables);
  });
  expect(requests).toHaveLength(3);
  expect(requests.at(2)?.headers.get("Idempotency-Key")).not.toBe(keys.at(0));
  client.clear();
});
