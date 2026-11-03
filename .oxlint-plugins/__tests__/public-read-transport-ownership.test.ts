import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { PUBLIC_READ_TRANSPORTS } from "../../apps/api/src/lib/legal-search/public-read-transports.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const OWNER =
  'import { withPublicReadIo as own } from "@/api/lib/legal-search/public-read-timeout-context";';
const sourcePath = "apps/api/src/lib/legal-search/corpus-index-client.ts";
const lint = async (lines: readonly string[]) =>
  await lintSingleRule(
    "require-owned-public-read-transport",
    lines.join("\n"),
    { plugin: "public-law-read-boundary", sourcePath, cwd: "scratch" },
  );

describe.serial("public-read transport ownership", () => {
  test("rejects raw fetch even inside an otherwise owned scope", async () => {
    expect(
      await lint([
        OWNER,
        'import { fetchWithTimeout as request } from "@stll/fetch";',
        'await own("corpus-index", async io => {',
        '  await request("https://example.test", { timeoutMs: 1000 });',
        '  await fetch("https://example.test");',
        '  await globalThis.fetch("https://example.test");',
        '  return io.fetch("https://example.test", { timeoutMs: 1000 }, async r => r.text());',
        "});",
      ]),
    ).toEqual([4, 5, 6]);
  });

  test("recognizes issued handles and stable handle and method aliases", async () => {
    expect(
      await lint([
        OWNER,
        'await own("corpus-index", async io => {',
        "  const handle = io;",
        "  const { fetch: request } = handle;",
        '  await request("https://example.test", { timeoutMs: 1000 }, async r => r.json());',
        '  return handle.fetchStream("https://example.test", { timeoutMs: 1000 });',
        "});",
      ]),
    ).toEqual([]);
  });

  test("recognizes a method destructured directly from the issued callback parameter", async () => {
    expect(
      await lint([
        OWNER,
        'await own("corpus-index", async ({ fetch: request }) =>',
        '  await request("https://example.test", { timeoutMs: 1000 }, async response => await response.json()));',
      ]),
    ).toEqual([]);
  });

  test("rejects fake handles and shadowed capability factories", async () => {
    expect(
      await lint([
        OWNER,
        'await own("corpus-index", async io => io.fetch("https://example.test", { timeoutMs: 1000 }, async r => r.json()));',
        "const fake = { fetch: request };",
        'fake.fetch("https://example.test", {});',
        'const forged = async io => io.fetch("https://example.test", {});',
        "const pretend = async (kind, run) => run(fake);",
        'await pretend("corpus-index", async io => io.fetch("https://example.test", {}));',
      ]),
    ).toEqual([4, 5, 7]);
  });

  test("rejects copied unissued methods and reassigned capability parameters", async () => {
    expect(
      await lint([
        OWNER,
        'await own("corpus-index", async io => {',
        "  const fake = { fetch: unknown };",
        "  const request = fake.fetch;",
        "  await request(url);",
        "  const { fetch: copied } = fake;",
        "  await copied(url);",
        "  io = fake;",
        "  return io.fetch(url, {});",
        "});",
      ]),
    ).toEqual([5, 7, 9]);
  });

  test("raw global aliases and indirect network invocations stay blocked", async () => {
    expect(
      await lint([
        OWNER,
        'await own("corpus-index", async io => {',
        "  const request = fetch;",
        "  await request(url);",
        "  await fetch.call(null, url);",
        "  const bound = fetch.bind(null);",
        "  await bound(url);",
        '  return io.fetch("https://example.test", {}, consume);',
        "});",
      ]),
    ).toEqual([4, 5, 6, 7]);
  });

  test("requires the registered kind and a canonical scope in every owner", async () => {
    expect(
      await lint([
        OWNER,
        'await own("database", async io => io.readTransaction(database, read));',
      ]),
    ).toEqual([1, 2]);
    expect(
      await lint([
        "const own = async (kind, run) => run(fake);",
        'await own("corpus-index", async io => io.fetch(url, {}));',
      ]),
    ).toEqual([1, 2]);
  });

  test("a raw transaction cannot replace the issued transaction capability", async () => {
    expect(
      await lintSingleRule(
        "require-owned-public-read-transport",
        [
          OWNER,
          'await own("database", async io => {',
          "  await database.transaction(read);",
          "  return io.readTransaction(database, read);",
          "});",
        ].join("\n"),
        {
          plugin: "public-law-read-boundary",
          sourcePath: PUBLIC_READ_TRANSPORTS.database[0],
          cwd: "scratch",
        },
      ),
    ).toEqual([3]);
  });

  test("a new public-read client cannot open an unregistered raw transport", async () => {
    expect(
      await lintSingleRule(
        "require-owned-public-read-transport",
        'await fetch("https://example.test");',
        {
          plugin: "public-law-read-boundary",
          sourcePath: "apps/api/src/lib/legal-search/new-client.ts",
          cwd: "scratch",
        },
      ),
    ).toEqual([1]);
  });
});

for (const [transport, paths] of Object.entries(PUBLIC_READ_TRANSPORTS)) {
  for (const owner of paths) {
    test(`registered ${transport} owner ${owner} reaches its issued I/O scope`, async () => {
      expect(
        await lintSingleRule(
          "require-owned-public-read-transport",
          readFileSync(owner, "utf-8"),
          {
            plugin: "public-law-read-boundary",
            sourcePath: owner,
            cwd: "scratch",
          },
        ),
      ).toEqual([]);
    });
  }
}

for (const mutation of [
  {
    transport: "database",
    owner: PUBLIC_READ_TRANSPORTS.database[0],
    before: "io.readTransaction(",
    after: "database.transaction(",
  },
  {
    transport: "corpus-index",
    owner: PUBLIC_READ_TRANSPORTS["corpus-index"][0],
    before: "io.fetch(",
    after: "fetch(",
  },
] as const) {
  test(`the ${mutation.transport} owner census rejects a raw transport mutation`, async () => {
    const source = readFileSync(mutation.owner, "utf-8");
    const changed = source.replace(mutation.before, () => mutation.after);
    expect(changed).not.toBe(source);
    expect(
      await lintSingleRule("require-owned-public-read-transport", changed, {
        plugin: "public-law-read-boundary",
        sourcePath: mutation.owner,
        cwd: "scratch",
      }),
    ).not.toEqual([]);
  });
}

test("the HTTP owner census rejects a forged callback-handle mutation", async () => {
  const owner = PUBLIC_READ_TRANSPORTS["corpus-index"][0];
  const source = readFileSync(owner, "utf-8");
  const changed = source.replace(
    "async (io) => {",
    "async (issued) => { const io = { fetch: globalThis.fetch };",
  );
  expect(changed).not.toBe(source);
  expect(
    await lintSingleRule("require-owned-public-read-transport", changed, {
      plugin: "public-law-read-boundary",
      sourcePath: owner,
      cwd: "scratch",
    }),
  ).not.toEqual([]);
});

test("the request forwarder is confined to the public-read scope owner", async () => {
  const code = [
    'import { fetchPublicReadRequest as request } from "@/api/lib/safe-outbound-fetch";',
    "await request({ capability, input, init });",
    'import * as outbound from "@/api/lib/safe-outbound-fetch";',
    "await outbound.fetchPublicReadRequest({ capability, input, init });",
    "const alias = outbound.fetchPublicReadRequest;",
    "export const forwarded = request;",
    'export { fetchPublicReadRequest as relay } from "@/api/lib/safe-outbound-fetch";',
    'export * from "@/api/lib/safe-outbound-fetch";',
  ].join("\n");
  const cases = [
    "apps/api/src/handlers/documents/read.ts",
    "apps/api/src/lib/legal-search/public-read-timeout-context.ts",
  ];
  const results = await Promise.all(
    cases.map(async (callerPath) => ({
      callerPath,
      lines: await lintSingleRule("require-owned-public-read-transport", code, {
        plugin: "public-law-read-boundary",
        sourcePath: callerPath,
        cwd: "scratch",
      }),
    })),
  );
  for (const { callerPath, lines } of results) {
    expect(lines).toEqual(
      callerPath.endsWith("public-read-timeout-context.ts")
        ? [6, 7, 8]
        : [1, 2, 4, 5, 6, 7, 8],
    );
  }
});

test("raw outbound requests are confined to the permit facade", async () => {
  const names = ["outboundRequests"];
  const cases = names.flatMap((name) => {
    const code = [
      `import { ${name} as request } from "@/api/lib/safe-outbound-fetch";`,
      "await request.bytes(options);",
      'import * as outbound from "@/api/lib/safe-outbound-fetch";',
      `await outbound.${name}.bytes(options);`,
      `const alias = outbound.${name};`,
      "export const forwarded = request;",
      `export { ${name} as relay } from "@/api/lib/safe-outbound-fetch";`,
      'export * from "@/api/lib/safe-outbound-fetch";',
    ].join("\n");
    return [
      "apps/api/src/handlers/documents/read.ts",
      "apps/api/src/lib/legal-search/public-read-timeout-context.ts",
      "apps/api/src/lib/auth/authorized-outbound-fetch.ts",
    ].map((callerPath) => ({ code, callerPath }));
  });
  const results = await Promise.all(
    cases.map(async ({ code, callerPath }) => ({
      callerPath,
      lines: await lintSingleRule("require-owned-public-read-transport", code, {
        plugin: "public-law-read-boundary",
        sourcePath: callerPath,
        cwd: "scratch",
      }),
    })),
  );
  for (const { callerPath, lines } of results) {
    expect(lines).toEqual(
      callerPath.endsWith("authorized-outbound-fetch.ts")
        ? [6, 7, 8]
        : [1, 2, 4, 5, 6, 7, 8],
    );
  }
});
