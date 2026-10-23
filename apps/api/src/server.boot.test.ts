import { expect, test } from "bun:test";

import api from "@/api/server";

test("the complete API route graph builds", () => {
  expect(api.routes.length).toBeGreaterThan(400);
});
