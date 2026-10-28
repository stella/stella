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

test("recognises explicit capability and app-only write declarations", () => {
  const source = `
import { api } from "@/lib/api";
await invokeCapability("items.create", async (request) => api.items.post(body, request));
await invokeAppOnlyWrite("items.internal.create", async () => api.internal.post(body));
`;
  expect(
    countUndeclaredApiClientWrites(source, "apps/web/src/example.ts"),
  ).toBe(0);
});
