import { expect, test } from "bun:test";

import { countUndeclaredEdenWrites } from "./undeclared-eden-writes";

test("counts undeclared writes through a member or a literal element access", () => {
  const source = `
import { api } from "@/lib/api";
await api.items.post(body);
await api.items["post"](body);
await api.items["get"]();
await api.items[method](body);
`;
  expect(countUndeclaredEdenWrites(source, "apps/web/src/example.ts")).toBe(2);
});

test("recognises the client under relative and aliased specifiers alike", () => {
  const write = "await api.items.post(body);";
  expect(
    countUndeclaredEdenWrites(
      `import { api } from "./api";\n${write}`,
      "apps/web/src/lib/example.ts",
    ),
  ).toBe(1);
  expect(
    countUndeclaredEdenWrites(
      `import { api } from "../lib/eden-client";\n${write}`,
      "apps/web/src/hooks/example.ts",
    ),
  ).toBe(1);
  expect(
    countUndeclaredEdenWrites(
      `import { api } from "./api";\n${write}`,
      "apps/web/src/lib/errors/example.ts",
    ),
  ).toBe(0);
});
