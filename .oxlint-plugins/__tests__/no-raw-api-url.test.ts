import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects raw relative API prefixes at all three transport constructors", async () => {
  expect(
    await lintSingleRule(
      "no-raw-api-url",
      `fetch("/api/entities");
new Request("/v1/entities");
new URL(\`/api/\${id}\`, origin);
fetch(\`\${env.VITE_API_URL}/v1/entities\`);`,
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("recognizes bare version and API prefix boundaries", async () => {
  expect(
    await lintSingleRule(
      "no-raw-api-url",
      'fetch("/api");\nnew URL("/v1", origin);',
    ),
  ).toEqual([1, 2]);
});

test("accepts canonical APIs and explicit other-service URLs", async () => {
  expect(
    await lintSingleRule(
      "no-raw-api-url",
      `fetch(apiUrl("/entities"));
new Request(externalApiUrl("/entities"));
fetch(\`\${DESKTOP_BRIDGE_URL}/v1/entities\`);`,
    ),
  ).toEqual([]);
});

test("does not confuse longer path segments or nontransport text with API URLs", async () => {
  expect(
    await lintSingleRule(
      "no-raw-api-url",
      'fetch("/apiculture");\nnew URL("/v10/items", origin);\nconst documentation = "/api/entities";\nclient.fetch("/api/entities");',
    ),
  ).toEqual([]);
});
