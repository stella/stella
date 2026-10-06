import { expect, test } from "bun:test";

import { addedEntries } from "./ledger-membership.ts";
import {
  compareTransferBaseline,
  findTransferReads,
  parseTransferBaseline,
  transferMembership,
} from "./transfer-read-guard.ts";

const file = "apps/api/src/handlers/export.ts";

test("SQL predicate subqueries stay server-side while ordinary capped reads are checked", () => {
  for (const predicate of ["inArray", "notInArray", "exists", "notExists"]) {
    const argumentsSource =
      predicate === "inArray" || predicate === "notInArray"
        ? "table.id, db.select().from(table).orderBy(table.id).limit(CAP)"
        : "db.select().from(table).orderBy(table.id).limit(CAP)";
    for (const localName of [predicate, "predicate"]) {
      const body = `${localName}(${argumentsSource})`;
      const source = `import { ${predicate} as ${localName} } from "drizzle-orm";
        const remove = () => db.delete(table).where(${body});`;
      expect(findTransferReads(file, source)).toEqual([]);
      for (const declaration of [localName, `{ ${localName} }`]) {
        expect(
          findTransferReads(
            file,
            source.replace(
              "const remove = ()",
              () => `const remove = (${declaration})`,
            ),
          ).map(({ kind }) => kind),
        ).toEqual(["constant-limit"]);
      }
      expect(
        findTransferReads(
          file,
          source.replace('"drizzle-orm"', '"./local"'),
        ).map(({ kind }) => kind),
      ).toEqual(["constant-limit"]);
      expect(
        findTransferReads(
          file,
          `import { ${predicate} as ${localName} } from "drizzle-orm";
            const rows = async () => {
              const items = await db.select().from(table).orderBy(table.id).limit(CAP);
              return ${localName}(items);
            };`,
        ).map(({ kind }) => kind),
      ).toEqual(["constant-limit"]);
    }
  }
});

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

test("single-row reads pass only for literal or resolved constant one", () => {
  for (const cap of ["1", "ONE", "singleton"]) {
    expect(
      findTransferReads(
        file,
        `const ONE = 1; const singleton = ONE; const lookup = () => query.limit(${cap});`,
      ),
    ).toEqual([]);
  }
  expect(
    findTransferReads(file, "const lookup = () => query.limit(2);").map(
      ({ kind }) => kind,
    ),
  ).toEqual(["constant-limit"]);
  expect(
    findTransferReads(
      file,
      "const ONE = 1; const lookup = ({ ONE }) => query.limit(ONE);",
    ).map(({ kind }) => kind),
  ).toEqual(["constant-limit"]);
  expect(
    findTransferReads(
      file,
      "const lookup = () => query['limit'](LIMITS.exportRowLimit);",
    ).map(({ kind }) => kind),
  ).toEqual(["constant-limit"]);
});

test("sentinel reads pass only with a matching early overflow decision", () => {
  const safe = `
    const exportRows = async () => {
      const pageSize = LIMITS.exportRowLimit;
      const rows = await query.limit(pageSize + 1);
      if (rows.length > pageSize) return { type: "overflow" };
      return makeCsv(rows);
    };
  `;
  expect(findTransferReads(file, safe)).toEqual([]);
  for (const decision of [
    "if (rows.length > pageSize) console.log('overflow');",
    "if (otherRows.length > pageSize) return { type: 'overflow' };",
    "if (rows.length > OTHER_CAP) return { type: 'overflow' };",
    "if (rows.length > pageSize) return makeCsv(rows);",
    "if (rows.length > pageSize) { if (debug) return { type: 'overflow' }; }",
    "",
  ]) {
    const source = safe.replace(
      'if (rows.length > pageSize) return { type: "overflow" };',
      () => decision,
    );
    expect(findTransferReads(file, source).map(({ kind }) => kind)).toEqual([
      "fixed-page-size",
    ]);
  }
  expect(
    findTransferReads(
      file,
      `
    const exportRows = async () => {
      const rows = makeCsv(await query.limit(LIMITS.exportRowLimit + 1));
      if (rows.length > LIMITS.exportRowLimit) return { type: "overflow" };
      return rows;
    };
  `,
    ).map(({ kind }) => kind),
  ).toEqual(["constant-limit"]);
});

test("offset pagination must be on the limited query chain", () => {
  expect(
    findTransferReads(
      file,
      "const exportRows = () => tx.select().limit(LIMITS.exportRowLimit).offset(0);",
    ).map(({ kind }) => kind),
  ).toEqual(["constant-limit"]);
  for (const query of [
    "tx.select().limit(LIMITS.pageSize).offset(page * LIMITS.pageSize)",
    "tx.select().offset(page * LIMITS.pageSize).limit(LIMITS.pageSize)",
  ]) {
    expect(findTransferReads(file, `const list = (page) => ${query};`)).toEqual(
      [],
    );
  }
  expect(
    findTransferReads(
      file,
      `
    const exportRows = () => {
      unrelated.offset(100);
      return tx.select().limit(LIMITS.exportRowLimit);
    };
  `,
    ).map(({ kind }) => kind),
  ).toEqual(["constant-limit"]);
});

test("literal sentinel probes require a proven overflow exit", () => {
  const source = `
    import { panic } from "better-result";
    const lookup = async () => {
      const rows = await query.limit(2);
      if (rows.length > 1) panic("Duplicate match");
      return rows.at(0);
    };
  `;
  expect(findTransferReads(file, source)).toEqual([]);
  expect(
    findTransferReads(
      file,
      source.replace('panic("Duplicate match")', 'log("Duplicate match")'),
    ).map(({ kind }) => kind),
  ).toEqual(["constant-limit"]);
});

test("canonical page construction consumes the matching sentinel result and cap", () => {
  const source = `
    import { createCursorPage } from "@/api/lib/pagination";
    const list = async () => {
      const rows = await query.limit(LIMITS.itemsMax + 1);
      const page = createCursorPage({ rows, limit: LIMITS.itemsMax, cursorForItem: item => item.id });
      return Result.ok(page);
    };
  `;
  expect(findTransferReads(file, source)).toEqual([]);
  for (const unsafe of [
    source.replace("limit: LIMITS.itemsMax", "limit: OTHER_CAP"),
    source.replace("{ rows, limit", "{ rows: otherRows, limit"),
    source.replace("return Result.ok(page)", "return makeCsv(rows)"),
    source.replace('from "@/api/lib/pagination"', 'from "./custom-page"'),
  ]) {
    expect(findTransferReads(file, unsafe).map(({ kind }) => kind)).toEqual([
      "constant-limit",
    ]);
  }
});

test("cursor pagination must reach the limited query where clause", () => {
  expect(
    findTransferReads(
      file,
      `
    const list = ({ cursor }) => tx.select().where(gt(table.id, cursor)).limit(LIMITS.pageSize);
  `,
    ),
  ).toEqual([]);
  expect(
    findTransferReads(
      file,
      `
    const list = ({ query }) => {
      const after = decodeCursor(query.cursor);
      const conditions = gt(table.id, after);
      return tx.select().where(conditions).limit(LIMITS.pageSize);
    };
  `,
    ),
  ).toEqual([]);
  expect(
    findTransferReads(
      file,
      `
    const list = ({ cursor }) => {
      displayCursor(cursor);
      return tx.select().where(eq(table.enabled, true)).limit(LIMITS.pageSize);
    };
  `,
    ).map(({ kind }) => kind),
  ).toEqual(["fixed-page-size"]);
  expect(
    findTransferReads(
      file,
      `
    const list = ({ cursor }) => tx.select().where(eq(table.cursor, "fixed-value")).limit(LIMITS.pageSize);
  `,
    ).map(({ kind }) => kind),
  ).toEqual(["fixed-page-size"]);
});

test("page classification consumes the old fixed-limit budget without adding headroom", () => {
  const row = { file, function: "list", reason: "Existing fixed read." };
  const members = (rows: unknown[]) =>
    transferMembership(JSON.stringify(rows), "fixture");
  const old = members([{ ...row, kind: "constant-limit", count: 2 }]);
  const split = members([
    { ...row, kind: "constant-limit", count: 1 },
    { ...row, kind: "fixed-page-size", count: 1 },
  ]);
  expect(split).toEqual(old);
  const enlarged = members([
    { ...row, kind: "constant-limit", count: 1 },
    { ...row, kind: "fixed-page-size", count: 2 },
  ]);
  expect(addedEntries(enlarged, old)).toHaveLength(1);
  expect(
    addedEntries(
      members([
        { ...row, function: "newList", kind: "fixed-page-size", count: 1 },
      ]),
      old,
    ),
  ).toHaveLength(1);
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
