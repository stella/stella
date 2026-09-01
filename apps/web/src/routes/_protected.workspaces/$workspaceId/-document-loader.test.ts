import { QueryClient } from "@tanstack/react-query";
import { beforeAll, expect, test } from "bun:test";

beforeAll(() => {
  process.env["VITE_API_URL"] ??= "https://api.example.test";
});

test("starts the chat connector catalogue while the entity gate is unresolved", async () => {
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(
    queryClient.getQueryState(connectorOptions.queryKey)?.fetchStatus,
  ).toBe("fetching");
  expect(entityGateResolved).toBeFalse();

  await queryClient.cancelQueries({ queryKey: connectorOptions.queryKey });
  entity.resolve({ id: "entity-A" });
  expect(await loadPromise).toEqual({ id: "entity-A" });
});
