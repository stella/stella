import { expect, test } from "bun:test";

import { addedEntries } from "./ledger-membership.ts";
import {
  compareTransferBaseline,
  findTransferReads,
  parseTransferBaseline,
  transferMembership,
} from "./transfer-read-guard.ts";

const file = "apps/api/src/handlers/export.ts";

test("numeric timeout streaming and unchecked export fixtures are rejected", () => {
  const streaming = findTransferReads(
    file,
    `
    export const download = async () => {
      const response = await fetchWithTimeout(url, { timeoutMs: 30_000 });
      return new Response(response.body);
    };
  `,
  );
  expect(streaming.map(({ kind }) => kind).toSorted()).toEqual([
    "numeric-timeout",
    "total-timeout-body",
  ]);
  const exporting = findTransferReads(
    file,
    `
    export const exportRows = async () => {
      const rows = await scopedDb(tx => tx.select().from(rows).limit(LIMITS.exportRowLimit));
      return makeCsv(rows);
    };
  `,
  );
  expect(exporting.map(({ kind }) => kind)).toEqual(["constant-limit"]);
  expect(
    compareTransferBaseline([...streaming, ...exporting], []).unlisted,
  ).toHaveLength(3);
});

test("explicit idle policy and bounded owner fixtures pass", () => {
  expect(
    findTransferReads(
      file,
      `
    export const download = async () => {
      const response = await fetchWithTimeout(url, { timeout: { type: "idle", ms: 30_000 } });
      return new Response(response.body);
    };
    export const exportRows = async () => {
      const result = await readBounded(query, LIMITS.exportRowLimit);
      return result.type === "complete" ? makeCsv(result.rows) : rejectOverflow();
    };
  `,
    ),
  ).toEqual([]);
  expect(
    findTransferReads(
      "apps/api/src/lib/db/read-bounded.ts",
      `
    export const readBounded = async (query, CAP) => query.limit(CAP + 1);
  `,
    ),
  ).toEqual([]);
});

test("all response consumption forms cooccur with a total timeout", () => {
  for (const consume of [
    "response.arrayBuffer()",
    "response.blob()",
    "response.text()",
    "response.json()",
    "new Response(response.body)",
    "({ body: response.body })",
    "response.body.pipeTo(target)",
    "response.body.getReader()",
    'new Response(response["body"])',
  ]) {
    expect(
      findTransferReads(
        file,
        `
      const download = async () => {
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        return ${consume};
      };
    `,
      ).map(({ kind }) => kind),
    ).toEqual(["total-timeout-body"]);
  }
});

test("timeouts and reads in separate functions do not cooccur", () => {
  expect(
    findTransferReads(
      file,
      `
    const headers = () => fetch(url, { signal: AbortSignal.timeout(100) });
    const consume = response => response.text();
  `,
    ),
  ).toEqual([]);
});

test("nested function identities survive whitespace and source movement", () => {
  const source = `export const exportRows = () => scopedDb(tx => tx.select().limit(LIMITS.exportRowLimit));`;
  const before = findTransferReads(file, source);
  const after = findTransferReads(file, `\n\nconst unused = 1;\n${source}`);
  expect(before.map(({ function: fn }) => fn)).toEqual(["module/exportRows"]);
  expect(after.map(({ function: fn }) => fn)).toEqual(
    before.map(({ function: fn }) => fn),
  );
  expect(after.at(0)?.line).not.toBe(before.at(0)?.line);
});

test("callback transfers and aliased fetch options remain inside the owning function", () => {
  const findings = findTransferReads(
    file,
    `
    import { fetchWithTimeout as transfer } from "@stll/fetch";
    const defaults = { timeoutMs: 30_000 } as const;
    const options = { ...defaults };
    const download = async () => {
      const response = await Result.tryPromise({ try: () => transfer(url, options) });
      return new Response(response.value.body);
    };
  `,
  );
  expect(findings.map(({ kind }) => kind).toSorted()).toEqual([
    "numeric-timeout",
    "total-timeout-body",
  ]);
  expect(new Set(findings.map(({ function: fn }) => fn))).toEqual(
    new Set(["module/download"]),
  );
});

test("fetch wrappers and computed timeout access cannot bypass the census", () => {
  for (const helper of [
    "fetchWithRetry",
    "safeFetchDocument",
    "fetchPublisher",
  ]) {
    expect(
      findTransferReads(
        file,
        `const download = () => ${helper}(url, { timeoutMs: 100 });`,
      ).map(({ kind }) => kind),
    ).toEqual(["numeric-timeout"]);
  }
  expect(
    findTransferReads(
      file,
      `
    const request = createFetchWithTimeout({ timeout: { type: "headers", ms: 100 } });
    const download = () => request(url, { timeoutMs: 100 });
  `,
    ).map(({ kind }) => kind),
  ).toEqual(["numeric-timeout"]);
  expect(
    findTransferReads(
      file,
      `
    const Signals = AbortSignal;
    const download = async () => {
      const response = await fetch(url, { signal: Signals["timeout"](100) });
      return response.text();
    };
  `,
    ).map(({ kind }) => kind),
  ).toEqual(["total-timeout-body"]);
});

test("lowercase constant bindings need budgets while shadowed page inputs do not", () => {
  expect(
    findTransferReads(
      file,
      `
    const cap = 100;
    const exportRows = () => query.limit(cap);
  `,
    ).map(({ kind }) => kind),
  ).toEqual(["constant-limit"]);
  expect(
    findTransferReads(
      file,
      `
    const cap = 100;
    const list = (cap) => query.limit(cap);
  `,
    ),
  ).toEqual([]);
  expect(
    findTransferReads(
      file,
      "const cap = cap + 1; const exportRows = () => query.limit(cap);",
    ).map(({ kind }) => kind),
  ).toEqual(["constant-limit"]);
});

test("literal, named, arithmetic and computed constant limits need a contract", () => {
  for (const limit of [
    "10_000",
    "EXPORT_CAP",
    "LIMITS.exportRowLimit",
    "LIMITS.exportRowLimit + 1",
    'LIMITS["exportRowLimit"]',
  ]) {
    expect(
      findTransferReads(
        file,
        `const exportRows = () => query.limit(${limit});`,
      ).map(({ kind }) => kind),
    ).toEqual(["constant-limit"]);
  }
  expect(
    findTransferReads(
      file,
      "const list = ({ limit }) => query.limit(limit + 1);",
    ),
  ).toEqual([]);
  expect(
    findTransferReads(
      "apps/web/src/query.ts",
      "const list = () => query.limit(LIMITS.rows);",
    ),
  ).toEqual([]);
});

test("existing budgets match exactly and repaired functions must leave the baseline", () => {
  const findings = findTransferReads(
    file,
    "const exportRows = () => query.limit(LIMITS.exportRowLimit);",
  );
  const baseline = parseTransferBaseline(
    JSON.stringify([
      {
        file,
        function: "module/exportRows",
        kind: "constant-limit",
        count: 1,
        reason: "Existing export read.",
      },
    ]),
    "fixture",
  );
  expect(compareTransferBaseline(findings, baseline)).toEqual({
    unlisted: [],
    stale: [],
  });
  expect(compareTransferBaseline([], baseline).stale).toHaveLength(1);
  expect(
    compareTransferBaseline([...findings, ...findings], baseline).unlisted,
  ).toHaveLength(2);
});

test("shared membership guard forbids replacement members and increased budgets", () => {
  const make = (fn: string, count: number) =>
    transferMembership(
      JSON.stringify([
        {
          file,
          function: fn,
          kind: "constant-limit",
          count,
          reason: "Existing export read.",
        },
      ]),
      "fixture",
    );
  expect(addedEntries(make("exportRows", 1), make("exportRows", 2))).toEqual(
    [],
  );
  expect(
    addedEntries(make("exportRows", 2), make("exportRows", 1)),
  ).toHaveLength(1);
  expect(
    addedEntries(make("replacement", 1), make("exportRows", 1)),
  ).toHaveLength(1);
});

test("baseline rejects missing reasons and duplicate function budgets", () => {
  expect(() =>
    parseTransferBaseline('[{"file":"export.ts"}]', "fixture"),
  ).toThrow("must contain reasoned");
  const row = {
    file,
    function: "exportRows",
    kind: "constant-limit",
    count: 1,
    reason: "Existing read.",
  };
  expect(() =>
    parseTransferBaseline(JSON.stringify([row, row]), "fixture"),
  ).toThrow("duplicate file/function");
});
