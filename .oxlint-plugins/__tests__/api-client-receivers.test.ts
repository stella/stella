import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const RECEIVERS = [
  "api.lists({ workspaceId })({ listId })",
  '(api["lists"]({ workspaceId }))({ listId })',
  "api.lists({ workspaceId })({ listId }).items({ itemId })",
  "api.workspaces({ workspaceId })",
  "api.chat.threads({ threadId })",
  'api["docx-suggestions"]({ workspaceId }).entity({ entityId })',
];

for (const receiver of RECEIVERS) {
  test(`retains network ownership through stable receiver aliases: ${receiver}`, async () => {
    const declarations = `import { api } from "@/lib/api";\nconst route = ${receiver};\nconst alias = route;\n`;
    expect(
      await lintSingleRule(
        "no-network-await-in-loop",
        `${declarations}async function run() { for (const id of ids) { await alias["long-route"].post({ id }); } }`,
      ),
    ).toEqual([4]);
    expect(
      await lintSingleRule(
        "no-network-in-transaction",
        `${declarations}async function run() { await db.transaction(async () => { await alias["long-route"].post({}); }); }`,
      ),
    ).toEqual([4]);
    expect(
      await lintSingleRule(
        "require-query-signal",
        `${declarations}const options = { queryKey: ["items"], queryFn: () => alias["long-route"].get() };`,
      ),
    ).toEqual([4]);
  });
}

test("retains the local-browser network boundary through receiver aliases", async () => {
  expect(
    await lintSingleRule(
      "local-browser-no-network",
      'import { api } from "@/lib/api";\nconst route = api.workspaces({ workspaceId });\nconst alias = route;\nalias["long-route"].get();',
    ),
  ).toEqual([2, 4]);
});

test("accepts query cancellation through a stable receiver alias", async () => {
  expect(
    await lintSingleRule(
      "require-query-signal",
      'import { api } from "@/lib/api";\nconst route = api.workspaces({ workspaceId });\nconst options = { queryKey: ["items"], queryFn: ({ signal }) => route["long-route"].get({ fetch: { signal } }) };',
    ),
  ).toEqual([]);
});

const NON_RECEIVERS = [
  "const route = api.lists({ workspaceId }).get()({ listId });",
  "const route = createClient()({ listId });",
  "const route = api.lists({ workspaceId })({ listId }).get()();",
  "const route = api.workspaces({ workspaceId }).options();",
  'const method = "get"; const route = api.workspaces({ workspaceId })[method]();',
  "const request = api.workspaces({ workspaceId }).get; const route = request();",
  "const route = await api.workspaces({ workspaceId }).get();",
  "const route = api.workspaces({ workspaceId }).post({});",
  'const route = api.workspaces({ workspaceId })["get"]();',
  "let route = api.workspaces({ workspaceId }); route = localClient;",
  "const route = localClient.workspaces({ workspaceId });",
  "const first = second; const second = first; const route = first;",
  "const { route } = api.workspaces({ workspaceId });",
];

for (const declaration of NON_RECEIVERS) {
  test(`does not treat a value as a route receiver: ${declaration}`, async () => {
    const source = `import { api } from "@/lib/api";\n${declaration}\n`;
    expect(
      await lintSingleRule(
        "no-network-await-in-loop",
        `${source}async function run() { for (const id of ids) { await route.get(id); } }`,
      ),
    ).toEqual([]);
    expect(
      await lintSingleRule(
        "require-query-signal",
        `${source}const options = { queryKey: ["items"], queryFn: () => route.get() };`,
      ),
    ).toEqual([]);
  });
}

test("resolves receiver aliases in their lexical scope", async () => {
  expect(
    await lintSingleRule(
      "no-network-await-in-loop",
      'import { api } from "@/lib/api";\nconst route = api.workspaces({ workspaceId });\nasync function local(route) { for (const id of ids) { await route.get(id); } }\nasync function remote() { for (const id of ids) { await route.get(id); } }',
    ),
  ).toEqual([4]);
});
