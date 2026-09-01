import { expect, test } from "bun:test";

const documentRouteSource = await Bun.file(
  new URL("$viewId.document.tsx", import.meta.url),
).text();
const chatSessionSource = await Bun.file(
  new URL("../../../features/chat/hooks/use-chat-session.ts", import.meta.url),
).text();

test("the document loader starts the chat session catalogue before its entity gate", () => {
  const connectorFactory =
    /const \{ data: mcpCatalog \} = useQuery\(\s*([A-Za-z_$][\w$]*)\(/u.exec(
      chatSessionSource,
    )?.[1];

  expect(connectorFactory).toBeDefined();
  const loaderPrefetch = new RegExp(
    String.raw`prefetchRouteQuery\(\s*context\.queryClient,\s*${connectorFactory}\(context\.user\.activeOrganizationId\)`,
    "u",
  );
  const connectorPrefetchIndex = documentRouteSource.search(loaderPrefetch);
  const entityGateIndex = documentRouteSource.indexOf(
    "const entity = await ensureRouteQueryData",
  );

  expect(connectorPrefetchIndex).toBeGreaterThanOrEqual(0);
  expect(entityGateIndex).toBeGreaterThan(connectorPrefetchIndex);
});
