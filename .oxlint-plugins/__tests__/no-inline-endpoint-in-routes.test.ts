import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects workspace and root endpoint definitions in route wiring", async () => {
  expect(
    await lintSingleRule(
      "no-inline-endpoint-in-routes",
      "const read = createSafeHandler({ config, handler });\nconst search = createSafeRootHandler(config, handler);",
      { sourcePath: "apps/api/src/handlers/example/routes.ts" },
    ),
  ).toEqual([1, 2]);
});

test("rejects public and token endpoint definitions in route wiring", async () => {
  expect(
    await lintSingleRule(
      "no-inline-endpoint-in-routes",
      "const publicRead = createSafePublicHandler({ config, handler });\nconst tokenRead = createSafeTokenHandler({ config, handler });",
      { sourcePath: "apps/api/src/handlers/example/routes.ts" },
    ),
  ).toEqual([1, 2]);
});

test("accepts endpoint imports and mounting their handlers", async () => {
  expect(
    await lintSingleRule(
      "no-inline-endpoint-in-routes",
      'import read from "./read";\napp.get("/", read.handler);',
      { sourcePath: "apps/api/src/handlers/example/routes.ts" },
    ),
  ).toEqual([]);
});

test("accepts unrelated factory calls in route wiring", async () => {
  expect(
    await lintSingleRule(
      "no-inline-endpoint-in-routes",
      'const schema = createSchema({ field: "name" });',
      { sourcePath: "apps/api/src/handlers/example/routes.ts" },
    ),
  ).toEqual([]);
});
