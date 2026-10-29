import { expect, test } from "bun:test";

import { countUndeclaredApiClientWrites } from "./undeclared-api-client-writes";

test("counts undeclared writes through a member or a literal element access", () => {
  const source = `
import { api } from "@/lib/api";
await api.items.post(body);
await api.items["post"](body);
await api.items["get"]();
await api.items[method](body);
`;
  expect(
    countUndeclaredApiClientWrites(source, "apps/web/src/example.ts"),
  ).toBe(2);
});

test("recognises the client under relative and aliased specifiers alike", () => {
  const write = "await api.items.post(body);";
  expect(
    countUndeclaredApiClientWrites(
      `import { api } from "./api";\n${write}`,
      "apps/web/src/lib/example.ts",
    ),
  ).toBe(1);
  expect(
    countUndeclaredApiClientWrites(
      `import { api } from "../lib/api";\n${write}`,
      "apps/web/src/hooks/example.ts",
    ),
  ).toBe(1);
  expect(
    countUndeclaredApiClientWrites(
      `import { api } from "./api";\n${write}`,
      "apps/web/src/lib/errors/example.ts",
    ),
  ).toBe(0);
});

const INTERNAL_UI_OWNER = "apps/web/src/lib/api.ts";
const internalUiWrites = `
import { INTERNAL_UI_TRANSPORT_ROUTES } from "@stll/api-contract/internal-ui-transport";
export const mcpConnectorConnection = {
  route: INTERNAL_UI_TRANSPORT_ROUTES.mcpConnectorConnect,
  start: async (slug: string) => api.mcp.connectors({ slug }).connect.post({}),
} as const;
export const chatConnectorReceipt = {
  route: INTERNAL_UI_TRANSPORT_ROUTES.chatConnectorReceipt,
  submit: async ({ threadId, toolCallId, decision }) =>
    api.chat.threads({ threadId }).connectors({ toolCallId }).post({ decision }),
} as const;
`;
const internalUiSource = `
import { createApiClient } from "@stll/api-client";
export const apiClient = createApiClient(baseUrl, options);
export const api = apiClient.v1;
${internalUiWrites}
`;

test("only the two manifest-bound writes in their owning module are exempt", () => {
  expect(
    countUndeclaredApiClientWrites(internalUiSource, INTERNAL_UI_OWNER),
  ).toBe(0);
  expect(
    countUndeclaredApiClientWrites(
      `import { api } from "@/lib/api";\n${internalUiWrites}`,
      "apps/web/src/lib/another-transport.ts",
    ),
  ).toBe(2);
});

test("an altered client initializer cannot make owner writes disappear", () => {
  const aliased = internalUiSource
    .replace(
      'import { createApiClient } from "@stll/api-client";',
      'import { createApiClient as buildClient } from "@stll/api-client";',
    )
    .replace(
      "createApiClient(baseUrl, options)",
      "buildClient(baseUrl, options)",
    );
  expect(countUndeclaredApiClientWrites(aliased, INTERNAL_UI_OWNER)).toBe(2);
});

test("changed route identity, path, method, or client syntax remains counted", () => {
  const mutations = [
    internalUiSource.replace(
      "route: INTERNAL_UI_TRANSPORT_ROUTES.mcpConnectorConnect",
      "route: INTERNAL_UI_TRANSPORT_ROUTES.chatConnectorReceipt",
    ),
    internalUiSource.replace("api.mcp.connectors", "api.mcp.other"),
    internalUiSource.replace(".connect.post({})", ".connect.patch({})"),
    internalUiSource.replace(
      "api.mcp.connectors({ slug })",
      'api.mcp["connectors"]({ slug })',
    ),
    internalUiSource
      .replace(
        "start: async (slug: string) => api.mcp",
        "start: async (slug: string) => { const client = api; return client.mcp",
      )
      .replace(".connect.post({}),", ".connect.post({}); },"),
  ];
  for (const mutation of mutations) {
    expect(countUndeclaredApiClientWrites(mutation, INTERNAL_UI_OWNER)).toBe(1);
  }
});

test("another write, even to the same internal route, remains counted", () => {
  expect(
    countUndeclaredApiClientWrites(
      internalUiSource.replace(
        "api.mcp.connectors({ slug }).connect.post({}),",
        "(await api.mcp.connectors({ slug }).connect.post({}), await api.mcp.connectors({ slug }).connect.post({})),",
      ),
      INTERNAL_UI_OWNER,
    ),
  ).toBe(1);
  expect(
    countUndeclaredApiClientWrites(
      internalUiSource.replace(
        "api.mcp.connectors({ slug }).connect.post({}),",
        "(await api.mcp.connectors({ slug }).connect.post({}), await api.other.post({})),",
      ),
      INTERNAL_UI_OWNER,
    ),
  ).toBe(1);
});
