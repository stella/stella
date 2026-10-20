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
