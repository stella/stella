import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  checkWriteContracts,
  DEFERRED_REPLACEMENT_REASON,
  enumerateWriteContracts,
  writeContractBaseline,
} from "./check-write-contracts";
import type {
  WriteContractBaseline,
  WriteRoute,
} from "./check-write-contracts";

const handler = "apps/api/src/handlers/example/update.ts";
const owner = "apps/api/src/lib/write-contract/write-contract.ts";
const UPDATED_AT = {
  contract: "replace",
  precondition: { type: "updatedAt", field: "expectedUpdatedAt" },
};
const DEFERRED = {
  contract: "replace",
  precondition: { type: "deferred", baselineId: handler },
  description: "Replace contents",
};

/** A served POST route backed by the example handler export. */
const route = (
  recorded: unknown,
  overrides: Partial<WriteRoute> = {},
): WriteRoute => ({
  method: "POST",
  path: "/existing",
  endpoint: handler,
  recorded,
  ...overrides,
});
const enumerate = ({
  routes,
  sources = new Map<string, string>(),
  raw = {},
}: {
  routes: WriteRoute[];
  sources?: Map<string, string>;
  raw?: Record<string, unknown>;
}) =>
  enumerateWriteContracts({
    routes,
    raw,
    load: (file) => sources.get(file),
  });
const check = (options: Parameters<typeof enumerate>[0]) =>
  checkWriteContracts({
    registrations: enumerate(options),
    baseline: [],
    previous: [],
  });
const baselineFor = (
  registrations: ReturnType<typeof enumerate>,
): WriteContractBaseline =>
  registrations.map((registration) => ({
    key: registration.key,
    count: 1,
    baselineId: handler,
    reason: "Existing fixture requires caller enrollment.",
  }));
/** The example handler module: one safe factory call around `body`. */
const handlerSource = (body: string, imports = "") =>
  `import { createSafeHandler } from '@/api/lib/api-handlers';
  import { enforceWritePrecondition } from '@/api/lib/write-contract/write-contract';
  ${imports}
  export default createSafeHandler({contract: 'replace'}, async ({ body }) => { ${body} });`;
const withHandler = (source: string) => new Map([[handler, source]]);

describe("write contracts cover the served mutation routes", () => {
  test("a route without a recorded or raw contract fails", () => {
    expect(check({ routes: [route(undefined)] })).toEqual([
      "Missing write contract: POST /existing",
    ]);
    expect(check({ routes: [route({ contract: "patch" })] })).toEqual([]);
    expect(check({ routes: [route({ description: "Update" })] })).toEqual([
      "Missing write contract: POST /existing",
    ]);
  });

  test("a Replace description requires the replace contract", () => {
    expect(
      check({
        routes: [route({ contract: "patch", description: "Replace contents" })],
      }),
    ).toEqual([
      "Replace description requires replace contract: POST /existing",
    ]);
  });

  test("raw declarations bind exactly the routes no safe factory built", () => {
    const rawRoute = route(undefined, { path: "/raw", endpoint: undefined });
    expect(check({ routes: [rawRoute] })).toEqual([
      "Missing write contract: POST /raw",
    ]);
    expect(
      check({
        routes: [rawRoute],
        raw: { "POST /raw": { contract: "patch" } },
      }),
    ).toEqual([]);
    expect(() =>
      enumerate({
        routes: [{ ...rawRoute, path: "/moved" }],
        raw: { "POST /raw": { contract: "patch" } },
      }),
    ).toThrow("Stale raw write contract: POST /raw");
    expect(() =>
      enumerate({
        routes: [rawRoute],
        raw: { "PUT /raw": { contract: "patch" } },
      }),
    ).toThrow("Stale raw write contract: PUT /raw");
  });

  test("raw metadata cannot override a recorded safe-handler contract", () => {
    expect(() =>
      enumerate({
        routes: [route({ contract: "patch" })],
        raw: { "POST /existing": { contract: "patch" } },
      }),
    ).toThrow("Raw write contract cannot override a safe handler:");
  });

  test("replacement precondition metadata must match its declared protocol", () => {
    expect(check({ routes: [route({ contract: "replace" })] })).toEqual([
      "Replace route requires precondition: POST /existing",
    ]);
    const sources = new Map([
      [
        owner,
        'const REVISION_PRECONDITIONS = {existing: ["revision"]} as const;',
      ],
    ]);
    const cases: [unknown, string][] = [
      [
        { type: "updatedAt", field: "optionalToken" },
        "Timestamp precondition requires field expectedUpdatedAt",
      ],
      [
        { type: "revision", fields: [] },
        "Revision precondition requires registered fields",
      ],
      [
        { type: "revision", fields: ["other"] },
        "Revision precondition requires registered fields",
      ],
      [
        { type: "deferred", baselineId: handler, field: "extra" },
        "Precondition fields must match the declared protocol",
      ],
      ["deferred", "Precondition fields must match the declared protocol"],
    ];
    for (const [precondition, message] of cases) {
      expect(
        check({
          routes: [route({ contract: "replace", precondition })],
          sources,
        }),
      ).toContainEqual(expect.stringContaining(message));
    }
    expect(
      check({
        routes: [
          route({
            contract: "patch",
            precondition: { type: "updatedAt", field: "expectedUpdatedAt" },
          }),
        ],
      }),
    ).toContainEqual(
      expect.stringContaining("Patch contract cannot declare a precondition"),
    );
  });

  test("a deferred replacement is bound to its handler export, or to its route", () => {
    expect(
      checkWriteContracts({
        registrations: enumerate({
          routes: [
            route({
              ...DEFERRED,
              precondition: { type: "deferred", baselineId: "another.ts" },
            }),
          ],
        }),
        baseline: [],
        previous: [],
      }),
    ).toContainEqual("Misbound deferred baseline ID: POST /existing");
    const rawKey = "POST /raw";
    const registrations = enumerate({
      routes: [route(undefined, { path: "/raw", endpoint: undefined })],
      raw: {
        [rawKey]: {
          contract: "replace",
          precondition: { type: "deferred", baselineId: rawKey },
        },
      },
    });
    expect(registrations.at(0)?.baselineId).toBe(rawKey);
    expect(
      checkWriteContracts({
        registrations,
        baseline: writeContractBaseline(registrations),
        previous: undefined,
        debtIds: [rawKey],
      }),
    ).toEqual([]);
  });
});

describe("the deferred replacement baseline", () => {
  test("introducing the baseline admits exactly the generated rows", () => {
    const registrations = enumerate({ routes: [route(DEFERRED)] });
    const generated = writeContractBaseline(registrations);
    expect(generated).toEqual([
      {
        key: "POST /existing",
        count: 1,
        reason: DEFERRED_REPLACEMENT_REASON,
        baselineId: handler,
      },
    ]);
    expect(
      checkWriteContracts({
        registrations,
        baseline: generated,
        previous: undefined,
      }),
    ).toEqual([]);
    expect(
      checkWriteContracts({
        registrations,
        baseline: baselineFor(registrations),
        previous: undefined,
      }),
    ).toContainEqual(
      expect.stringContaining("Write baseline may only shrink:"),
    );
  });

  test("a newly deferred route fails against the base baseline", () => {
    const original = enumerate({ routes: [route(DEFERRED)] });
    const planted = enumerate({
      routes: [route(DEFERRED), route(DEFERRED, { path: "/planted" })],
    });
    const baseline = baselineFor(original);
    const entry = baseline.at(0);
    if (entry === undefined) {
      panic("Fixture must enumerate its route");
    }
    expect(
      checkWriteContracts({
        registrations: planted,
        baseline: [...baseline, { ...entry, key: "POST /planted" }],
        previous: baseline,
      }),
    ).toContainEqual("Write baseline may only shrink: POST /planted");
  });

  test("baseline duplicate, count, reason, identity and stale changes fail", () => {
    const registrations = enumerate({ routes: [route(DEFERRED)] });
    const baseline = baselineFor(registrations);
    const entry = baseline.at(0);
    if (entry === undefined) {
      panic("Fixture must enumerate its route");
    }
    const validate = (changed: WriteContractBaseline) =>
      checkWriteContracts({
        registrations,
        baseline: changed,
        previous: baseline,
      });
    expect(validate([...baseline, entry])).toContainEqual(
      expect.stringContaining("Duplicate write baseline key:"),
    );
    expect(validate([{ ...entry, count: 2 }])).toContainEqual(
      expect.stringContaining("Write baseline may only shrink:"),
    );
    expect(validate([{ ...entry, reason: "Revised reason" }])).toContainEqual(
      expect.stringContaining("Write baseline may only shrink:"),
    );
    expect(validate([{ ...entry, baselineId: "another.ts" }])).toContainEqual(
      expect.stringContaining("Misbound write baseline ID:"),
    );
    expect(validate([{ ...entry, key: `${entry.key}/moved` }])).toContainEqual(
      expect.stringContaining("Stale write baseline count:"),
    );
    expect(validate([{ ...entry, reason: " " }])).toContainEqual(
      expect.stringContaining("Missing write baseline reason:"),
    );
    expect(validate([])).toContainEqual(
      expect.stringContaining("Unbaselined deferred replace route:"),
    );
    expect(
      checkWriteContracts({
        registrations: [],
        baseline: [],
        previous: baseline,
      }),
    ).toEqual([]);
  });

  test("debt IDs and the exact baseline must shrink together", () => {
    const registrations = enumerate({ routes: [route(DEFERRED)] });
    const baseline = baselineFor(registrations);
    expect(
      checkWriteContracts({
        registrations,
        baseline,
        previous: baseline,
        debtIds: [handler, "orphan.ts"],
      }),
    ).toContainEqual(expect.stringContaining("Orphan write contract debt ID:"));
    expect(
      checkWriteContracts({
        registrations,
        baseline,
        previous: baseline,
        debtIds: [],
      }),
    ).toContainEqual(
      expect.stringContaining("Missing write contract debt ID:"),
    );
  });
});

describe("a replacement reaches the owner's enforcement", () => {
  const call = `enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt', expectedUpdatedAt: body.expectedUpdatedAt, storedUpdatedAt: new Date(), resource: 'Example'})`;
  const enforcementOf = (source: string, recorded: unknown = UPDATED_AT) =>
    check({ routes: [route(recorded)], sources: withHandler(source) });
  const missing = expect.stringContaining(
    "Replacement must reach owner enforcement",
  );

  const resultHandler = `import {Result} from 'better-result';
    import {createSafeRootHandler} from '@/api/lib/api-handlers';
    import {enforceWritePrecondition} from '@/api/lib/write-contract/write-contract';
    import {withAggregateRowQuery} from '@/api/lib/db/aggregate-lock';
    import {HandlerError} from '@/api/lib/errors/tagged-errors';
    import {savedSearches} from '@/api/db/schema';
    export default createSafeRootHandler({contract:'replace'}, async function* ({body, safeDb}) {
      const outcome = yield* Result.await(safeDb(async (tx) => {
        const acquired = await withAggregateRowQuery({aggregate:'savedSearch',id:{id:body.id,organizationId:body.organizationId,userId:body.userId},tx,mode:'update',select:readTx=>readTx.select().from(savedSearches)});
        const stored = acquired.rows.at(0);
        if (!stored) return Result.err(new HandlerError({status:404,message:'missing'}));
        const conflict = enforceWritePrecondition({type:'updatedAt',field:'expectedUpdatedAt',storedUpdatedAt:stored.updatedAt,expectedUpdatedAt:body.expectedUpdatedAt});
        if (conflict) return Result.err(conflict);
        return Result.ok(await tx.replace(body));
      }));
      const row = yield* outcome;
      return Result.ok(row);
    });`;

  test("real root-context safeDb propagates both canonical Result layers", () => {
    expect(enforcementOf(resultHandler)).toEqual([]);
    const aliased = resultHandler
      .replace("{Result}", "{Result as Outcome}")
      .replaceAll("Result.", "Outcome.")
      .replace(
        "{createSafeRootHandler}",
        "{createSafeRootHandler as createRoot}",
      )
      .replace("default createSafeRootHandler(", "default createRoot(")
      .replace(
        "{enforceWritePrecondition}",
        "{enforceWritePrecondition as enforce}",
      )
      .replace(
        "const conflict = enforceWritePrecondition(",
        "const conflict = enforce(",
      )
      .replace("body, safeDb}", "body, safeDb: database}")
      .replace("await(safeDb(", "await(database(");
    expect(enforcementOf(aliased)).toEqual([]);
    expect(
      enforcementOf(
        resultHandler.replace(
          "const outcome =",
          "if (!body) return Result.err(new Error('missing body')); const outcome =",
        ),
      ),
    ).toEqual([]);
  });

  test("Result transaction proof requires actual immutable context and import bindings", () => {
    for (const source of [
      resultHandler.replace("'@/api/lib/api-handlers'", "'./fake-factory'"),
      resultHandler.replace("'better-result'", "'./fake-result'"),
      resultHandler.replace(
        "'@/api/lib/write-contract/write-contract'",
        "'./fake-enforcer'",
      ),
      resultHandler.replace("body, safeDb}", "body, safeDb = fake}"),
      resultHandler.replace("body, safeDb}", "body, ['safeDb']: safeDb}"),
      resultHandler.replace("body, safeDb}", "body, ...safeDb}"),
      resultHandler
        .replace("body, safeDb}", "body, database}")
        .replace("await(safeDb(", "await(database.safeDb("),
      resultHandler.replace(
        "const outcome =",
        "safeDb = fake; const outcome =",
      ),
      resultHandler.replace(
        "const outcome =",
        "({safeDb} = fake); const outcome =",
      ),
      resultHandler.replace("const outcome =", "var safeDb; const outcome ="),
      resultHandler
        .replace("const outcome =", "{ const safeDb = fake; const outcome =")
        .replace("return Result.ok(row);", "return Result.ok(row); }"),
      resultHandler.replace(
        "const outcome =",
        "Result.await = fake; const outcome =",
      ),
      resultHandler.replace(
        "const outcome =",
        "Result.err = fake; const outcome =",
      ),
      resultHandler.replace(
        "const outcome =",
        "Object.assign(Result, {err: fake}); const outcome =",
      ),
      resultHandler.replace(
        "const outcome =",
        "mutate(Result); const outcome =",
      ),
      resultHandler.replace(
        "const outcome =",
        "const alias = Result; alias.err = fake; const outcome =",
      ),
      resultHandler.replace(
        "const outcome =",
        "class Result {} const outcome =",
      ),
      resultHandler.replace(
        "const outcome =",
        "const Result = fake; const outcome =",
      ),
      resultHandler.replace(
        "const outcome =",
        "createSafeRootHandler = fake; const outcome =",
      ),
      resultHandler.replace(
        "const conflict =",
        "enforceWritePrecondition = fake; const conflict =",
      ),
      resultHandler.replace(
        "async (tx) =>",
        "async (enforceWritePrecondition) =>",
      ),
      resultHandler.replace("async (tx) =>", "async (Result) =>"),
      resultHandler.replace("field:'expectedUpdatedAt'", "field:'other'"),
    ]) {
      expect(enforcementOf(source)).toContainEqual(missing);
    }
  });

  test("neither a swallowed Result nor an uninvoked nested callback proves refusal", () => {
    for (const source of [
      resultHandler.replace("yield* Result.await", "yield Result.await"),
      resultHandler.replace("yield* Result.await", "Result.await"),
      resultHandler.replace("yield* outcome", "yield outcome"),
      resultHandler.replace("yield* outcome", "Result.ok(outcome)"),
      resultHandler.replace("const row = yield* outcome;", "const row = {};"),
      resultHandler.replace(
        "const row = yield* outcome;",
        "const alias = Result.ok({}); const row = yield* alias;",
      ),
      resultHandler.replace(
        "const row = yield* outcome;",
        "try { const row = yield* outcome; } catch { return Result.ok({}); }",
      ),
      resultHandler.replace(
        "const row = yield* outcome;",
        "try { const row = yield* outcome; } finally { return Result.ok({}); }",
      ),
      resultHandler.replace(
        "Result.err(conflict)",
        "Result.err(new Error('different'))",
      ),
      resultHandler.replace("Result.err(conflict)", "Result.ok(conflict)"),
      resultHandler.replace(
        "if (!stored) return Result.err(new HandlerError({status:404,message:'missing'}));",
        "if (!stored) return Result.ok({});",
      ),
      resultHandler
        .replace(
          "const conflict = enforceWritePrecondition",
          "const conflict = ignore(() => enforceWritePrecondition",
        )
        .replace("body.expectedUpdatedAt});", "body.expectedUpdatedAt}));"),
      resultHandler.replace(
        "const acquired = await",
        "return Result.ok({}); const acquired = await",
      ),
      resultHandler.replace(
        "const outcome = yield*",
        "return Result.ok({}); const outcome = yield*",
      ),
      resultHandler.replace(
        "const outcome = yield*",
        "return Result.err(new Error('early')); const outcome = yield*",
      ),
      resultHandler.replace(
        "const outcome = yield*",
        "throw new Error('early'); const outcome = yield*",
      ),
      resultHandler.replace(
        "const conflict =",
        "return Result.err(new Error('early')); const conflict =",
      ),
      resultHandler.replace(
        "const conflict =",
        "throw new Error('early'); const conflict =",
      ),
      resultHandler.replace(
        "const outcome = yield*",
        "{ return Result.err(new Error('early')); } const outcome = yield*",
      ),
      resultHandler.replace(
        "const outcome = yield*",
        "{ throw new Error('early'); } const outcome = yield*",
      ),
      resultHandler.replace(
        "const conflict =",
        "{ return Result.err(new Error('early')); } const conflict =",
      ),
      resultHandler.replace(
        "const conflict =",
        "{ throw new Error('early'); } const conflict =",
      ),
      resultHandler.replace("safeDb(async (tx) =>", "ignore(async (tx) =>"),
      resultHandler.replace(
        "if (conflict) return Result.err(conflict);",
        "if (conflict) { const conflict = other; return Result.err(conflict); }",
      ),
    ]) {
      expect(enforcementOf(source)).toContainEqual(missing);
    }
  });

  test("loop assignment heads replace the actual protected binding", () => {
    for (const statement of [
      "for (safeDb of [fake]) {}",
      "for (safeDb in fake) {}",
      "for ({safeDb} of [fake]) {}",
      "for ({safeDb} in fake) {}",
      "for ([safeDb] of [fake]) {}",
      "for ([safeDb] in fake) {}",
      "for ({[key]: safeDb} of [fake]) {}",
      "({[key]: [safeDb]} = fake);",
      "const counters={}; ({[safeDb=fake]:counters.value}=fake);",
    ]) {
      expect(
        enforcementOf(
          resultHandler.replace(
            "const outcome =",
            () => `${statement} const outcome =`,
          ),
        ),
      ).toContainEqual(missing);
    }
  });

  test("property names and loop-local bindings stay independent", () => {
    for (const statement of [
      "const counters={safeDb:0}; counters.safeDb += 1;",
      "const counters={safeDb:0}; for (counters.safeDb of [1]) {}",
      "const counters={}; ({safeDb:counters.other} = fake);",
      "const counters={}; counters[safeDb] = 1;",
      "for (let safeDb of [fake]) {safeDb=fake;}",
      "for (let safeDb in fake) {safeDb='other';}",
      "for (const {safeDb} of [fake]) {use(safeDb);}",
    ]) {
      expect(
        enforcementOf(
          resultHandler.replace(
            "const outcome =",
            () => `${statement} const outcome =`,
          ),
        ),
      ).toEqual([]);
    }
  });

  test("the canonical locked read supports genuine owner, table and error import aliases", () => {
    const aliases = resultHandler
      .replace(
        "{withAggregateRowQuery}",
        "{withAggregateRowQuery as readLocked}",
      )
      .replace("await withAggregateRowQuery(", "await readLocked(")
      .replace("{HandlerError}", "{HandlerError as MissingError}")
      .replace("new HandlerError(", "new MissingError(")
      .replace("{savedSearches}", "{savedSearches as records}")
      .replaceAll("from(savedSearches)", "from(records)");
    expect(enforcementOf(aliases)).toEqual([]);
    expect(
      enforcementOf(
        `import {eq} from 'drizzle-orm';${resultHandler.replace(
          ".from(savedSearches)",
          ".from(savedSearches).where(eq(savedSearches.id, body.id))",
        )}`,
      ),
    ).toContainEqual(missing);
  });

  test("a returned Result refusal cannot credit writes or opaque effects before the comparison", () => {
    for (const statement of [
      "await tx.insert(savedSearches).values(body);",
      "await tx.update(savedSearches).set(body);",
      "await tx.delete(savedSearches);",
      "await tx.execute(body);",
      "await writeBeforeCheck(tx,body);",
      "const write=()=>tx.update(savedSearches).set(body); await write();",
      "if (body.enabled) await tx.update(savedSearches).set(body);",
      "for (const item of body.items) await tx.insert(savedSearches).values(item);",
    ]) {
      expect(
        enforcementOf(
          resultHandler.replace(
            "const acquired =",
            () => `${statement} const acquired =`,
          ),
        ),
      ).toContainEqual(missing);
      expect(
        enforcementOf(
          resultHandler.replace(
            "const conflict =",
            () => `${statement} const conflict =`,
          ),
        ),
      ).toContainEqual(missing);
    }
    for (const changed of [
      resultHandler.replace("'@/api/lib/db/aggregate-lock'", "'./fake-lock'"),
      resultHandler.replace(
        "'@/api/lib/errors/tagged-errors'",
        "'./fake-error'",
      ),
      resultHandler.replace("'@/api/db/schema'", "'./fake-table'"),
      resultHandler.replace("mode:'update'", "mode:'read'"),
      resultHandler.replace("id:body.id", "id:writeBeforeCheck(tx)"),
      resultHandler.replace(
        "readTx.select()",
        "readTx.select({value:tx.execute(body)})",
      ),
      resultHandler.replace(
        "readTx.select().from(savedSearches)",
        "readTx.update(savedSearches).set(body)",
      ),
      resultHandler.replace(
        "readTx.select().from(savedSearches)",
        "readTx.execute(body)",
      ),
      resultHandler.replace(
        ".from(savedSearches)",
        ".from(savedSearches).where(eq(savedSearches.id,tx.execute(body)))",
      ),
      resultHandler.replace(
        ".from(savedSearches)",
        ".from(savedSearches).where((tx.execute(body),eq(savedSearches.id,body.id)))",
      ),
      resultHandler.replace(
        ".from(savedSearches)",
        ".from(savedSearches).where(row=>eq(row.id,body.id))",
      ),
      resultHandler
        .replace("export default", "const predicate=eq; export default")
        .replace(
          ".from(savedSearches)",
          ".from(savedSearches).where(predicate(savedSearches.id,body.id))",
        ),
      resultHandler.replace("select:readTx=>", "select:async readTx=>"),
      resultHandler.replace(
        "readTx.select().from(savedSearches)",
        "(readTx=tx,readTx.select().from(savedSearches))",
      ),
      resultHandler.replace(
        "storedUpdatedAt:stored.updatedAt",
        "storedUpdatedAt:writeBeforeCheck(tx)",
      ),
      resultHandler.replace("if (!stored)", "if (body.missing)"),
      resultHandler.replace("status:404", "status:500"),
      resultHandler.replace(
        "new HandlerError({status:404,message:'missing'})",
        "new HandlerError({status:404,message:writeBeforeCheck(tx)})",
      ),
    ]) {
      expect(enforcementOf(changed)).toContainEqual(missing);
    }
  });

  test("a route no handler export backs cannot be traced", () => {
    expect(
      check({ routes: [route(UPDATED_AT, { endpoint: undefined })] }),
    ).toEqual([
      "Replacement must be an exported handler endpoint so its owner enforcement can be traced: POST /existing",
    ]);
  });

  test("a required token schema cannot authorize an unconditional replacement", () => {
    const guarded = `import { createSafeHandler } from '@/api/lib/api-handlers';
      import { enforceWritePrecondition as enforce } from '@/api/lib/write-contract/write-contract';
      export default createSafeHandler({contract: 'replace'}, async ({body, scopedDb}) =>
        scopedDb.transaction(async (tx) => {
          const stored = await tx.readForUpdate();
          const conflict = enforce({type: 'updatedAt', field: 'expectedUpdatedAt', expectedUpdatedAt: body.expectedUpdatedAt, storedUpdatedAt: stored.updatedAt, resource: 'Example'});
          if (conflict !== null) return conflict;
          return tx.replace(body);
        }));`;
    expect(enforcementOf(guarded)).toEqual([]);
    // Mutation: removing only the comparison leaves the handler intact.
    expect(
      enforcementOf(guarded.replace(/enforce\(\{type:[^;]+;/u, "null;")),
    ).toContainEqual(
      expect.stringContaining(
        "Replacement must reach owner enforcement for expectedUpdatedAt",
      ),
    );
  });

  test("owner identity, field and invoked helper reachability are required", () => {
    const helper = "apps/api/src/handlers/example/write.ts";
    const helperSource = `import { enforceWritePrecondition } from '@/api/lib/write-contract/write-contract';
      export const write = (body) => { const conflict = enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt', expectedUpdatedAt: body.expectedUpdatedAt, storedUpdatedAt: new Date(), resource: 'Example'}); if (conflict) return conflict; return {}; };`;
    const invoked = `import { createSafeHandler } from '@/api/lib/api-handlers'; import {write} from './write';
      export default createSafeHandler({contract: 'replace'}, async ({body}) => write(body));`;
    const run = (handlerCode: string, helperCode = helperSource) =>
      check({
        routes: [route(UPDATED_AT)],
        sources: new Map([
          [handler, handlerCode],
          [helper, helperCode],
        ]),
      });
    expect(run(invoked)).toEqual([]);
    for (const changed of [
      invoked.replace("write(body)", "({})"),
      invoked.replace("async ({body})", "async ({body, write})"),
    ]) {
      expect(run(changed)).toContainEqual(missing);
    }
    for (const changed of [
      helperSource.replace(
        "@/api/lib/write-contract/write-contract",
        "./lookalike",
      ),
      helperSource.replace("field: 'expectedUpdatedAt'", "field: 'revision'"),
    ]) {
      expect(run(invoked, changed)).toContainEqual(missing);
    }
  });

  test("lookalike factories and opaque wrappers cannot stand in for the handler", () => {
    const enforced = `const conflict = ${call}; if (conflict) return conflict; return {};`;
    for (const source of [
      `import { createSafeHandler } from './lookalike'; import { enforceWritePrecondition } from '@/api/lib/write-contract/write-contract'; export default createSafeHandler({}, async ({ body }) => { ${enforced} });`,
      `import { createSafeHandler } from '@/api/lib/api-handlers'; import { enforceWritePrecondition } from '@/api/lib/write-contract/write-contract'; const createEndpoint = (condition) => condition ? createSafeHandler({}, async ({ body }) => { ${enforced} }) : opaque(); export default createEndpoint();`,
      `import { createSafeHandler } from '@/api/lib/api-handlers'; import { enforceWritePrecondition } from '@/api/lib/write-contract/write-contract'; const createEndpoint = (condition) => condition ? createSafeHandler({}, async ({ body }) => { ${enforced} }) : createSafeHandler({}, async () => ({})); export default createEndpoint();`,
    ]) {
      expect(enforcementOf(source)).toContainEqual(missing);
    }
    expect(
      enforcementOf(
        `import { createSafeHandler } from '@/api/lib/api-handlers'; import { enforceWritePrecondition } from '@/api/lib/write-contract/write-contract'; const createEndpoint = (dependencies = {}) => createSafeHandler({}, async ({ body }) => { ${enforced} }); export default createEndpoint();`,
      ),
    ).toEqual([]);
  });

  test("block shadows and uninvoked callback arguments cannot stand in for enforcement", () => {
    for (const body of [
      `{ const enforceWritePrecondition = () => {}; enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt'}); }`,
      `const ignore = (callback) => {}; ignore(() => enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt'}));`,
      `return {}; enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt'});`,
    ]) {
      expect(enforcementOf(handlerSource(`${body} return {};`))).toContainEqual(
        missing,
      );
    }
  });

  test("a comparison that some write path can skip does not count", () => {
    const skippable = `enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt'})`;
    for (const body of [
      `if (body.expectedUpdatedAt) { const conflict = ${skippable}; if (conflict) return conflict; }`,
      `return body.expectedUpdatedAt && ${skippable};`,
      `return body.expectedUpdatedAt ? ${skippable} : undefined;`,
      `for (const item of body.items) { const conflict = ${skippable}; if (conflict) return conflict; }`,
      `try { body.check(); } catch { return ${skippable}; }`,
      `try { const conflict = ${skippable}; if (conflict) return conflict; } catch {}`,
      `try { const conflict = ${skippable}; if (conflict) return conflict; } finally { return {}; }`,
    ]) {
      expect(enforcementOf(handlerSource(`${body} return {};`))).toContainEqual(
        missing,
      );
    }
  });

  test("ignored, dropped and voided conflicts cannot authorize a replacement", () => {
    for (const body of [
      `${call};`,
      `const conflict = ${call};`,
      `void ${call};`,
      `const conflict = ${call}; if (conflict) { void conflict; }`,
      `const conflict = ${call}; if (conflict) { const conflict = null; return conflict; }`,
      `const conflict = ${call}; if (conflict === null) return conflict;`,
      `let conflict = ${call}; conflict = null; if (conflict) return conflict;`,
    ]) {
      expect(enforcementOf(handlerSource(`${body} return {};`))).toContainEqual(
        missing,
      );
    }
    for (const body of [
      `return ${call};`,
      `const conflict = ${call}; if (conflict) return conflict;`,
      `const conflict = ${call}; if (conflict !== null) { return conflict; }`,
    ]) {
      expect(enforcementOf(handlerSource(`${body} return {};`))).toEqual([]);
    }
  });

  test("an invoked helper must propagate its conflict through the handler", () => {
    const helper = "apps/api/src/handlers/example/write.ts";
    const helperSource = `import { enforceWritePrecondition } from '@/api/lib/write-contract/write-contract';
      export const write = () => enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt'});`;
    const run = (body: string) =>
      check({
        routes: [route(UPDATED_AT)],
        sources: new Map([
          [
            handler,
            `import { createSafeHandler } from '@/api/lib/api-handlers'; import { write } from './write';
            export default createSafeHandler({contract: 'replace'}, async () => { ${body} });`,
          ],
          [helper, helperSource],
        ]),
      });
    for (const body of [
      "write(); return {};",
      "const conflict = write(); return {};",
      "void write(); return {};",
    ]) {
      expect(run(body)).toContainEqual(missing);
    }
    expect(
      run(
        "const conflict = await write(); if (conflict) return conflict; return {};",
      ),
    ).toEqual([]);
  });

  test("compound revision declarations require every owner comparison", () => {
    const recorded = {
      contract: "replace",
      precondition: {
        type: "revision",
        fields: ["baseRevision", "selectedTextHash"],
      },
    };
    const guarded = `import { createSafeHandler } from '@/api/lib/api-handlers';
      import { enforceWritePrecondition } from '@/api/lib/write-contract/write-contract';
      export default createSafeHandler({contract: 'replace'}, async ({body}) => {
        const baseConflict = enforceWritePrecondition({type: 'revision', field: 'baseRevision', expectedRevision: body.baseRevision, storedRevision: 1, resource: 'Example'});
        if (baseConflict) return baseConflict;
        const hashConflict = enforceWritePrecondition({type: 'revision', field: 'selectedTextHash', expectedRevision: body.selectedTextHash, storedRevision: 'hash', resource: 'Example'});
        if (hashConflict) return hashConflict;
        return {};
      });`;
    const run = (source: string) =>
      check({
        routes: [route(recorded)],
        sources: new Map([
          [handler, source],
          [
            owner,
            `const REVISION_PRECONDITIONS = {message: ['baseRevision', 'selectedTextHash']};`,
          ],
        ]),
      });
    expect(run(guarded)).toEqual([]);
    expect(
      run(
        guarded.replace(
          /enforceWritePrecondition\(\{type: 'revision', field: 'selectedTextHash'[^;]+;/u,
          "null;",
        ),
      ),
    ).toContainEqual(
      expect.stringContaining(
        "Replacement must reach owner enforcement for selectedTextHash",
      ),
    );
  });
});
