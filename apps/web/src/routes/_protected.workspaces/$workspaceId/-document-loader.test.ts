import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeAll, expect, mock, test } from "bun:test";

beforeAll(() => {
  process.env["VITE_API_URL"] ??= "https://api.example.test";
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("starts the chat connector catalogue while the entity gate is unresolved", async () => {
  const connectorRequest = Promise.withResolvers<string | URL | Request>();
  const connectorResponse = Promise.withResolvers<Response>();
  const fetchMock = mock(async (input: string | URL | Request) => {
    connectorRequest.resolve(input);
    return await connectorResponse.promise;
  });
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  });
  const { loadDocumentEntityWithChatPrefetch } =
    await import("./-document-loader");
  const { mcpConnectorsOptions } = await import("@/lib/knowledge/queries");
  const queryClient = new QueryClient();
  const entity = Promise.withResolvers<{ id: string }>();
  const connectorOptions = mcpConnectorsOptions("organization-A");
  let entityGateResolved = false;

  const loadPromise = loadDocumentEntityWithChatPrefetch({
    activeOrganizationId: "organization-A",
    captureError: () => undefined,
    loadEntity: async () => await entity.promise,
    queryClient,
  });
  void loadPromise.then(() => {
    entityGateResolved = true;
    return undefined;
  });
  const request = await connectorRequest.promise;

  expect(new Request(request).url).toContain("/v1/mcp/connectors");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(
    queryClient.getQueryState(connectorOptions.queryKey)?.fetchStatus,
  ).toBe("fetching");
  expect(entityGateResolved).toBeFalse();

  entity.resolve({ id: "entity-A" });
  connectorResponse.resolve(Response.json([]));
  expect(await loadPromise).toEqual({ id: "entity-A" });
  await queryClient.query({ ...connectorOptions, staleTime: "static" });
});
