import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  checkWriteContracts,
  enumerateWriteContracts,
  readWriteContractDebtIds,
  writeContractBaselineSchema,
} from "./check-write-contracts";
import type { WriteContractBaseline } from "./check-write-contracts";

const root = path.resolve(import.meta.dir, "..");
const handler = "apps/api/src/handlers/example/update.ts";
const fixture = (config: string, route = "/existing") =>
  new Map([
    [
      "apps/api/src/server.ts",
      'import { routes } from "@/api/handlers/example/routes"; new Elysia().use(routes);',
    ],
    [
      "apps/api/src/handlers/example/routes.ts",
      `import update from "./update"; export const routes = new Elysia().post("${route}", update.handler);`,
    ],
    [
      handler,
      `import { createSafeHandler } from "@/api/lib/api-handlers"; const config = ${config}; const update = createSafeHandler(config, async () => ({})); export default update;`,
    ],
  ]);
const enumerate = (sources: Map<string, string>) =>
  enumerateWriteContracts((file) => sources.get(file));
const deferredConfig = `{contract: 'replace', precondition: {type: 'deferred', baselineId: '${handler}'}, description: 'Replace contents'}`;
const baselineFor = (
  registrations: ReturnType<typeof enumerate>,
): WriteContractBaseline =>
  registrations.map((route) => ({
    key: route.key,
    count: 1,
    baselineId: handler,
    reason: "Existing fixture requires caller enrollment.",
  }));
const check = (sources: Map<string, string>) =>
  checkWriteContracts({
    registrations: enumerate(sources),
    baseline: [],
    previous: [],
    previousRegistrations: [],
  });

describe("write contracts cover the mutation route graph", () => {
  test("a planted missing discriminator fails", () => {
    const sources = fixture(`{description: 'Update contents'}`);
    expect(enumerate(sources)).toHaveLength(1);
    expect(check(sources)).toEqual([
      expect.stringContaining("Missing write contract:"),
    ]);
    expect(
      check(fixture(`{contract: 'patch', description: 'Update contents'}`)),
    ).toEqual([]);
  });
  test("Replace descriptions cannot declare patch through imported spread configs", () => {
    const sources = fixture("{}");
    sources.set(
      handler,
      `import { createSafeHandler } from '@/api/lib/api-handlers'; import { shared as common } from './schema'; const config = {...common, description: 'Replace ' + 'contents'} satisfies HandlerConfig; const update = createSafeHandler(config, async () => ({})); export default update;`,
    );
    sources.set(
      "apps/api/src/handlers/example/schema.ts",
      'export const shared = {contract: "patch"} as const;',
    );
    expect(enumerate(sources).at(0)?.contract).toBe("patch");
    expect(check(sources)).toEqual([
      expect.stringContaining("Replace description requires replace contract:"),
    ]);
  });
  test("named factories and imported config aliases preserve declarations", () => {
    const sources = fixture("{}");
    sources.set(
      "apps/api/src/handlers/example/routes.ts",
      'import { update } from "./update"; export const routes = new Elysia().post("/existing", update.handler);',
    );
    sources.set(
      handler,
      'import { createSafeTokenHandler } from "@/api/lib/api-handlers"; import { config as settings } from "./schema"; export const update = createSafeTokenHandler(settings, async () => ({}));',
    );
    sources.set(
      "apps/api/src/handlers/example/schema.ts",
      'export const config = {contract: "patch"};',
    );
    expect(check(sources)).toEqual([]);
    expect(enumerate(sources).at(0)?.contract).toBe("patch");
  });
  test("newly deferred routes fail even on initial seeding", () => {
    const original = enumerate(fixture(deferredConfig));
    const planted = enumerate(fixture(deferredConfig, "/planted"));
    expect(planted.at(0)?.key).not.toBe(original.at(0)?.key);
    expect(
      checkWriteContracts({
        registrations: planted,
        baseline: baselineFor(planted),
        previous: undefined,
        previousRegistrations: original,
      }),
    ).toContainEqual(expect.stringContaining("New route cannot be deferred:"));
    expect(
      checkWriteContracts({
        registrations: original,
        baseline: baselineFor(original),
        previous: undefined,
        previousRegistrations: original,
      }),
    ).toEqual([]);
  });
  test("baseline duplicate, count, reason, identity and stale changes fail", () => {
    const registrations = enumerate(fixture(deferredConfig));
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
        previousRegistrations: [],
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
        previousRegistrations: [],
      }),
    ).toEqual([]);
  });
  test("duplicate registrations cannot increase a deferred allowance", () => {
    const original = enumerate(fixture(deferredConfig));
    const sources = fixture(deferredConfig);
    sources.set(
      "apps/api/src/handlers/example/routes.ts",
      'import update from "./update"; export const routes = new Elysia().post("/existing", update.handler).post("/existing", update.handler);',
    );
    const registrations = enumerate(sources);
    expect(registrations).toHaveLength(original.length + 1);
    const baseline = baselineFor(original);
    expect(
      checkWriteContracts({
        registrations,
        baseline,
        previous: baseline,
        previousRegistrations: original,
      }),
    ).toContainEqual(expect.stringContaining("Stale write baseline count:"));
    expect(
      checkWriteContracts({
        registrations,
        baseline: baseline.map((row) => ({ ...row, count: 2 })),
        previous: baseline,
        previousRegistrations: original,
      }),
    ).toContainEqual(
      expect.stringContaining("Write baseline may only shrink:"),
    );
  });
  test("raw boundaries require exact stable route declarations", () => {
    const sources = fixture("{}");
    const routes = "apps/api/src/handlers/example/routes.ts";
    sources.set(
      routes,
      'export const routes = new Elysia().post("/raw", async () => ({}));',
    );
    expect(check(sources)).toContainEqual(
      expect.stringContaining("Missing write contract:"),
    );
    sources.set(
      "apps/api/src/lib/write-contract.ts",
      `export const RAW_WRITE_CONTRACTS = {'${routes}|POST|/raw': {contract: 'patch'}} as const;`,
    );
    expect(check(sources)).toEqual([]);
    sources.set(
      routes,
      'export const routes = new Elysia().post("/moved", async () => ({}));',
    );
    expect(() => enumerate(sources)).toThrow("Stale raw write contract:");
  });
  test("canonical imports reject lookalikes and opaque later spreads", () => {
    const sources = fixture('{contract: "patch"}');
    sources.set(
      handler,
      'import { createSafeHandler } from "./lookalike"; export default createSafeHandler({contract: "patch"}, async () => ({}));',
    );
    expect(check(sources)).toContainEqual(
      expect.stringContaining("Missing write contract:"),
    );
    const opaque = fixture('{contract: "patch", ...opaqueSettings}');
    expect(check(opaque)).toContainEqual(
      expect.stringContaining("Missing write contract:"),
    );
    expect(check(fixture('{...opaqueSettings, contract: "patch"}'))).toEqual(
      [],
    );
  });
  test("raw metadata cannot override canonical safe-handler config", () => {
    const sources = fixture('{contract: "patch"}');
    sources.set(
      "apps/api/src/lib/write-contract.ts",
      "export const RAW_WRITE_CONTRACTS = {'apps/api/src/handlers/example/routes.ts|POST|/existing': {contract: 'patch'}} as const;",
    );
    expect(() => enumerate(sources)).toThrow(
      "Raw write contract cannot override a safe handler:",
    );
  });
  test("public subject factories expose their nested config through aliased canonical imports", () => {
    const sources = fixture("{}");
    sources.set(
      handler,
      'import { createSafePublicSubjectFollowUpHandler as safe } from "@/api/handlers/case-law/decisions/public-subject"; export default safe({config: {contract: "patch"}, locate: () => ({}), read: async () => ({})});',
    );
    expect(check(sources)).toEqual([]);
  });
  test("a required token schema cannot authorize an unconditional replacement", () => {
    const config = `{contract: 'replace', precondition: {type: 'updatedAt', field: 'expectedUpdatedAt'}, body: t.Object({expectedUpdatedAt: t.String({format: 'date-time'})})}`;
    const sources = fixture(config);
    const guarded = `import { t } from 'elysia';
      import { createSafeHandler } from '@/api/lib/api-handlers';
      import { enforceWritePrecondition as enforce } from '@/api/lib/write-contract';
      import { withAggregateTransaction } from '@/api/lib/db/aggregate-lock';
      export default createSafeHandler(${config}, async ({body, scopedDb}) =>
        await withAggregateTransaction(database, async (tx) => {
          const stored = await tx.readForUpdate();
          const conflict = enforce({type: 'updatedAt', field: 'expectedUpdatedAt', expectedUpdatedAt: body.expectedUpdatedAt, storedUpdatedAt: stored.updatedAt, resource: 'Example'});
          if (conflict !== null) return conflict;
          return tx.replace(body);
        }));`;
    const diagnostic = expect.stringContaining(
      "Replacement must reach owner enforcement for expectedUpdatedAt",
    );
    expect(enumerate(sources)).toHaveLength(1);
    expect(check(sources)).toContainEqual(diagnostic);
    sources.set(handler, guarded);
    expect(check(sources)).toEqual([]);
    // Mutation: removing only the comparison leaves the required body schema intact.
    sources.set(handler, guarded.replace(/enforce\(\{type:[^;]+;/u, ""));
    expect(sources.get(handler)).toContain("body: t.Object");
    expect(check(sources)).toContainEqual(diagnostic);
  });
  test("awaited canonical transactions propagate callback conflicts, and refuse dropped or uninvoked callbacks", () => {
    const config = `{contract: 'replace', precondition: {type: 'updatedAt', field: 'expectedUpdatedAt'}}`;
    const callback = `async (tx) => {
      const conflict = enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt'});
      if (conflict) return conflict;
      return tx.replace();
    }`;
    const sources = fixture(config);
    const withBody = (body: string, module = "@/api/lib/db/aggregate-lock") => `
      import { createSafeHandler } from '@/api/lib/api-handlers';
      import { enforceWritePrecondition } from '@/api/lib/write-contract';
      import { withAggregateTransaction as transaction } from '${module}';
      export default createSafeHandler(${config}, async () => { ${body} });`;
    for (const body of [
      `return await transaction(database, ${callback});`,
      `const conflict = await transaction(database, ${callback}); if (conflict) return conflict; return {};`,
    ]) {
      sources.set(handler, withBody(body));
      expect(check(sources)).toEqual([]);
    }
    for (const body of [
      `await transaction(database, ${callback}); return {};`,
      `const conflict = await transaction(database, ${callback}); return {};`,
      `const neverInvoked = ${callback}; return {};`,
      `return transaction(database, ${callback});`,
      `if (body.run) return await transaction(database, ${callback}); return {};`,
      `try { return await transaction(database, ${callback}); } catch { return {}; }`,
      `return await transaction(database, ${callback.replace("if (conflict) return conflict;", "")});`,
      `return await transaction(database, ${callback.replace("const conflict =", "if (body.run) { const conflict =").replace("return tx.replace();", "} return tx.replace();")});`,
    ]) {
      sources.set(handler, withBody(body));
      expect(check(sources)).toContainEqual(
        expect.stringContaining("Replacement must reach owner enforcement"),
      );
    }
    sources.set(
      handler,
      withBody(
        `return await transaction(database, ${callback});`,
        "./lookalike",
      ),
    );
    expect(check(sources)).toContainEqual(
      expect.stringContaining("Replacement must reach owner enforcement"),
    );
    sources.set(
      handler,
      withBody(`return await database.transaction(${callback});`),
    );
    expect(check(sources)).toContainEqual(
      expect.stringContaining("Replacement must reach owner enforcement"),
    );
  });
  test("safe handler database callbacks require the canonical Result bridge and conflict return", () => {
    const config = `{contract: 'replace', precondition: {type: 'updatedAt', field: 'expectedUpdatedAt'}}`;
    const sources = fixture(config);
    const callback = `async (tx) => { const conflict = enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt'}); if (conflict) return conflict; return tx.replace(); }`;
    const guarded = `import { Result } from 'better-result';
      import { HandlerError } from '@/api/lib/errors/tagged-errors';
      import { createSafeHandler } from '@/api/lib/api-handlers';
      import { enforceWritePrecondition } from '@/api/lib/write-contract';
      export default createSafeHandler(${config}, async function* ({safeDb: database}) {
        const updated = yield* Result.await(database(${callback}));
        if (HandlerError.is(updated)) return Result.err(updated);
        return Result.ok(updated);
      });`;
    sources.set(handler, guarded);
    expect(check(sources)).toEqual([]);
    for (const changed of [
      guarded.replace(
        "if (HandlerError.is(updated)) return Result.err(updated);",
        "",
      ),
      guarded.replace("@/api/lib/errors/tagged-errors", "./lookalike"),
      guarded.replace("return Result.err(updated)", "return updated"),
      guarded.replace("HandlerError.is(updated)", "updated"),
      guarded
        .replace("const updated =", "return")
        .replace(
          "if (HandlerError.is(updated)) return Result.err(updated);",
          "",
        ),
      guarded.replace("const updated =", "database = ignore; const updated ="),
      guarded.replace(
        "const updated =",
        "({database} = other); const updated =",
      ),
      guarded.replace("better-result", "./lookalike"),
      guarded.replace(
        "const updated =",
        "const database = other; const updated =",
      ),
      guarded.replace("if (conflict) return conflict;", ""),
      guarded.replace(
        "yield* Result.await(database",
        "yield* Result.await(ignore",
      ),
    ]) {
      sources.set(handler, changed);
      expect(check(sources)).toContainEqual(
        expect.stringContaining("Replacement must reach owner enforcement"),
      );
    }
  });
  test("generator write helpers execute only through returned delegation with the supplied safe handle", () => {
    const config = `{contract: 'replace', precondition: {type: 'updatedAt', field: 'expectedUpdatedAt'}}`;
    const sources = fixture(config);
    sources.set(
      "apps/api/src/handlers/example/write.ts",
      `
      import { Result } from 'better-result';
      import { HandlerError } from '@/api/lib/errors/tagged-errors';
      import { enforceWritePrecondition } from '@/api/lib/write-contract';
      export const write = async function* ({database}) {
        const updated = yield* Result.await(database(async () => {
          const conflict = enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt'});
          if (conflict) return conflict;
          return {};
        }));
        if (HandlerError.is(updated)) return Result.err(updated);
        return Result.ok(updated);
      };`,
    );
    const guarded = `import {createSafeHandler} from '@/api/lib/api-handlers'; import {write} from './write';
      export default createSafeHandler(${config}, async function* ({safeDb}) {return yield* write({database: safeDb});});`;
    sources.set(handler, guarded);
    expect(check(sources)).toEqual([]);
    for (const changed of [
      guarded.replace("return yield* write", "return write"),
      guarded.replace("return yield* write", "yield* write"),
      guarded.replace("database: safeDb", "database: ignore"),
      guarded.replace(
        "return yield* write",
        "safeDb = ignore; return yield* write",
      ),
    ]) {
      sources.set(handler, changed);
      expect(check(sources)).toContainEqual(
        expect.stringContaining("Replacement must reach owner enforcement"),
      );
    }
  });
  test("canonical module helpers cannot resolve writable aliases", () => {
    const config = `{contract: 'replace', precondition: {type: 'updatedAt', field: 'expectedUpdatedAt'}}`;
    const sources = fixture(config);
    const guarded = `import {createSafeHandler} from '@/api/lib/api-handlers'; import {withAggregateTransaction} from '@/api/lib/db/aggregate-lock'; import {enforceWritePrecondition} from '@/api/lib/write-contract';
      const transaction = withAggregateTransaction;
      export default createSafeHandler(${config}, async () => await transaction(database, async () => {
        const conflict = enforceWritePrecondition({type:'updatedAt',field:'expectedUpdatedAt'});
        if (conflict) return conflict;
        return {};
      }));`;
    sources.set(handler, guarded);
    expect(check(sources)).toEqual([]);
    sources.set(
      handler,
      guarded
        .replace("const transaction", "let transaction")
        .replace("export default", "transaction = ignore; export default"),
    );
    expect(check(sources)).toContainEqual(
      expect.stringContaining("Replacement must reach owner enforcement"),
    );
  });
  test("owner identity, field and invoked helper reachability are required", () => {
    const config = `{contract: 'replace', precondition: {type: 'updatedAt', field: 'expectedUpdatedAt'}}`;
    const sources = fixture(config);
    const helper = "apps/api/src/handlers/example/write.ts";
    sources.set(
      helper,
      `import { enforceWritePrecondition } from '@/api/lib/write-contract';
      export const write = (body) => { const conflict = enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt', expectedUpdatedAt: body.expectedUpdatedAt, storedUpdatedAt: new Date(), resource: 'Example'}); if (conflict) return conflict; return {}; };`,
    );
    const invoked = `import { createSafeHandler } from '@/api/lib/api-handlers'; import {write} from './write';
      export default createSafeHandler(${config}, async ({body}) => write(body));`;
    sources.set(handler, invoked);
    expect(check(sources)).toEqual([]);
    for (const changed of [
      invoked.replace("write(body)", "({})"),
      invoked.replace("async ({body})", "async ({body, write})"),
    ]) {
      sources.set(handler, changed);
      expect(check(sources)).toContainEqual(
        expect.stringContaining("Replacement must reach owner enforcement"),
      );
    }
    sources.set(handler, invoked);
    const original = sources.get(helper);
    if (original === undefined) {
      panic("Fixture helper must exist");
    }
    for (const changed of [
      original.replace("@/api/lib/write-contract", "./lookalike"),
      original.replace("field: 'expectedUpdatedAt'", "field: 'revision'"),
    ]) {
      sources.set(helper, changed);
      expect(check(sources)).toContainEqual(
        expect.stringContaining("Replacement must reach owner enforcement"),
      );
    }
  });
  test("block shadows and uninvoked callback arguments cannot stand in for enforcement", () => {
    const config = `{contract: 'replace', precondition: {type: 'updatedAt', field: 'expectedUpdatedAt'}}`;
    for (const body of [
      `{ const enforceWritePrecondition = () => {}; enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt'}); }`,
      `const ignore = (callback) => {}; ignore(() => enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt'}));`,
      `return {}; enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt'});`,
    ]) {
      const sources = fixture(config);
      sources.set(
        handler,
        `import { createSafeHandler } from '@/api/lib/api-handlers';
        import { enforceWritePrecondition } from '@/api/lib/write-contract';
        export default createSafeHandler(${config}, async () => { ${body} return {}; });`,
      );
      expect(check(sources)).toContainEqual(
        expect.stringContaining("Replacement must reach owner enforcement"),
      );
    }
  });
  test("a comparison that some write path can skip does not count", () => {
    const config = `{contract: 'replace', precondition: {type: 'updatedAt', field: 'expectedUpdatedAt'}}`;
    const call = `enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt'})`;
    for (const body of [
      `if (body.expectedUpdatedAt) { const conflict = ${call}; if (conflict) return conflict; }`,
      `return body.expectedUpdatedAt && ${call};`,
      `return body.expectedUpdatedAt ? ${call} : undefined;`,
      `for (const item of body.items) { const conflict = ${call}; if (conflict) return conflict; }`,
      `try { body.check(); } catch { return ${call}; }`,
      `try { const conflict = ${call}; if (conflict) return conflict; } catch {}`,
      `try { const conflict = ${call}; if (conflict) return conflict; } finally { return {}; }`,
    ]) {
      const sources = fixture(config);
      sources.set(
        handler,
        `import { createSafeHandler } from '@/api/lib/api-handlers';
        import { enforceWritePrecondition } from '@/api/lib/write-contract';
        export default createSafeHandler(${config}, async ({ body }) => { ${body} return {}; });`,
      );
      expect(check(sources)).toContainEqual(
        expect.stringContaining("Replacement must reach owner enforcement"),
      );
    }
  });
  test("ignored, dropped and voided conflicts cannot authorize a replacement", () => {
    const config = `{contract: 'replace', precondition: {type: 'updatedAt', field: 'expectedUpdatedAt'}, body: t.Object({expectedUpdatedAt: t.String({format: 'date-time'})})}`;
    const call = `enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt', expectedUpdatedAt: body.expectedUpdatedAt, storedUpdatedAt: new Date(), resource: 'Example'})`;
    const sources = fixture(config);
    const withBody = (
      body: string,
    ) => `import { t } from 'elysia'; import { createSafeHandler } from '@/api/lib/api-handlers';
      import { enforceWritePrecondition } from '@/api/lib/write-contract';
      export default createSafeHandler(${config}, async ({body}) => { ${body} return {}; });`;
    for (const body of [
      `${call};`,
      `const conflict = ${call};`,
      `void ${call};`,
      `const conflict = ${call}; if (conflict) { void conflict; }`,
      `const conflict = ${call}; if (conflict) { const conflict = null; return conflict; }`,
      `const conflict = ${call}; if (conflict === null) return conflict;`,
      `let conflict = ${call}; conflict = null; if (conflict) return conflict;`,
    ]) {
      sources.set(handler, withBody(body));
      expect(check(sources)).toContainEqual(
        expect.stringContaining("Replacement must reach owner enforcement"),
      );
    }
    for (const body of [
      `return ${call};`,
      `const conflict = ${call}; if (conflict) return conflict;`,
      `const conflict = ${call}; if (conflict !== null) { return conflict; }`,
    ]) {
      sources.set(handler, withBody(body));
      expect(check(sources)).toEqual([]);
    }
  });
  test("an invoked helper must propagate its conflict through the handler", () => {
    const config = `{contract: 'replace', precondition: {type: 'updatedAt', field: 'expectedUpdatedAt'}}`;
    const sources = fixture(config);
    sources.set(
      "apps/api/src/handlers/example/write.ts",
      `import { enforceWritePrecondition } from '@/api/lib/write-contract';
      export const write = () => enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt'});`,
    );
    for (const body of [
      "write(); return {};",
      "const conflict = write(); return {};",
      "void write(); return {};",
    ]) {
      sources.set(
        handler,
        `import { createSafeHandler } from '@/api/lib/api-handlers'; import { write } from './write';
        export default createSafeHandler(${config}, async () => { ${body} });`,
      );
      expect(check(sources)).toContainEqual(
        expect.stringContaining("Replacement must reach owner enforcement"),
      );
    }
    sources.set(
      handler,
      `import { createSafeHandler } from '@/api/lib/api-handlers'; import { write } from './write';
      export default createSafeHandler(${config}, async () => { const conflict = await write(); if (conflict) return conflict; return {}; });`,
    );
    expect(check(sources)).toEqual([]);
  });
  test("compound revision declarations require every owner comparison", () => {
    const config = `{contract: 'replace', precondition: {type: 'revision', fields: ['baseRevision', 'selectedTextHash']}}`;
    const sources = fixture(config);
    sources.set(
      "apps/api/src/lib/write-contract.ts",
      `const REVISION_PRECONDITIONS = {message: ['baseRevision', 'selectedTextHash']};`,
    );
    const guarded = `import { createSafeHandler } from '@/api/lib/api-handlers';
      import { enforceWritePrecondition } from '@/api/lib/write-contract';
      export default createSafeHandler(${config}, async ({body}) => {
        const baseConflict = enforceWritePrecondition({type: 'revision', field: 'baseRevision', expectedRevision: body.baseRevision, storedRevision: 1, resource: 'Example'});
        if (baseConflict) return baseConflict;
        const hashConflict = enforceWritePrecondition({type: 'revision', field: 'selectedTextHash', expectedRevision: body.selectedTextHash, storedRevision: 'hash', resource: 'Example'});
        if (hashConflict) return hashConflict;
        return {};
      });`;
    sources.set(handler, guarded);
    expect(check(sources)).toEqual([]);
    sources.set(
      handler,
      guarded.replace(
        /enforceWritePrecondition\(\{type: 'revision', field: 'selectedTextHash'[^;]+;/u,
        "",
      ),
    );
    expect(check(sources)).toContainEqual(
      expect.stringContaining(
        "Replacement must reach owner enforcement for selectedTextHash",
      ),
    );
  });
  test("replacement precondition metadata must match its declared protocol", () => {
    expect(check(fixture('{contract: "replace"}'))).toContainEqual(
      expect.stringContaining("Replace route requires precondition:"),
    );
    expect(
      check(
        fixture(
          '{contract: "replace", precondition: {type: "updatedAt", field: "optionalToken"}}',
        ),
      ),
    ).toContainEqual(
      expect.stringContaining(
        "Timestamp precondition requires field expectedUpdatedAt",
      ),
    );
    expect(
      check(
        fixture(
          '{contract: "replace", precondition: {type: "revision", fields: []}}',
        ),
      ),
    ).toContainEqual(
      expect.stringContaining(
        "Revision precondition requires registered fields",
      ),
    );
    expect(
      check(
        fixture(
          '{contract: "patch", precondition: {type: "updatedAt", field: "expectedUpdatedAt"}}',
        ),
      ),
    ).toContainEqual(
      expect.stringContaining("Patch contract cannot declare a precondition"),
    );
    const sources = fixture(
      '{contract: "replace", precondition: {type: "revision", fields: ["revision"]}}',
    );
    sources.set(
      "apps/api/src/lib/write-contract.ts",
      'const REVISION_PRECONDITIONS = {existing: ["revision"]} as const;',
    );
    expect(check(sources)).toEqual([
      expect.stringContaining(
        "Replacement must reach owner enforcement for revision",
      ),
    ]);
  });
  test("debt IDs and the exact baseline must shrink together", () => {
    const registrations = enumerate(fixture(deferredConfig));
    const baseline = baselineFor(registrations);
    expect(
      checkWriteContracts({
        registrations,
        baseline,
        previous: baseline,
        previousRegistrations: [],
        debtIds: [handler, "orphan.ts"],
      }),
    ).toContainEqual(expect.stringContaining("Orphan write contract debt ID:"));
    expect(
      checkWriteContracts({
        registrations,
        baseline,
        previous: baseline,
        previousRegistrations: [],
        debtIds: [],
      }),
    ).toContainEqual(
      expect.stringContaining("Missing write contract debt ID:"),
    );
  });
  test("stable endpoint wrappers preserve the returned canonical factory contract", () => {
    const wrappers = [
      "(dependencies = {}) => createSafeHandler(config, async () => ({}))",
      "(dependencies = {}) => {const read = dependencies.read; return createSafeHandler(config, async () => ({}));}",
      '() => {const localConfig = {contract: "patch"}; const endpoint = createSafeHandler(localConfig, async () => ({})); return endpoint;}',
    ];
    for (const wrapper of wrappers) {
      const sources = fixture("{}");
      sources.set(
        handler,
        `import {createSafeHandler} from "@/api/lib/api-handlers"; const config = {contract: "patch"}; const createEndpoint = ${wrapper}; const endpoint = createEndpoint(); export default endpoint;`,
      );
      expect(enumerate(sources)).toHaveLength(1);
      expect(check(sources)).toEqual([]);
    }
  });
  test("wrapper configs cannot resolve missing declarations or shadowed module bindings", () => {
    const wrappers = [
      "() => createSafeHandler({}, async () => ({}))",
      "(config) => createSafeHandler(config, async () => ({}))",
      '() => {let config = {contract: "patch"}; return createSafeHandler(config, async () => ({}));}',
      "() => {const config = opaque(); return createSafeHandler(config, async () => ({}));}",
      "(createSafeHandler) => createSafeHandler(config, async () => ({}))",
    ];
    for (const wrapper of wrappers) {
      const sources = fixture("{}");
      sources.set(
        handler,
        `import {createSafeHandler} from "@/api/lib/api-handlers"; const config = {contract: "patch"}; const createEndpoint = ${wrapper}; export default createEndpoint();`,
      );
      expect(enumerate(sources)).toHaveLength(1);
      expect(check(sources)).toContainEqual(
        expect.stringContaining("Missing write contract:"),
      );
    }
  });
  test("divergent or opaque wrapper returns cannot select a convenient declaration", () => {
    const wrappers = [
      '(condition) => {if (condition) return createSafeHandler({contract: "patch"}, async () => ({})); return createSafeHandler({contract: "replace"}, async () => ({}));}',
      '(condition) => condition ? createSafeHandler({contract: "patch"}, async () => ({})) : createSafeHandler({contract: "replace", precondition: {type: "updatedAt", field: "expectedUpdatedAt"}}, async () => ({}))',
      '(condition) => condition ? createSafeHandler({contract: "patch"}, async () => ({})) : opaque()',
    ];
    for (const wrapper of wrappers) {
      const sources = fixture("{}");
      sources.set(
        handler,
        `import {createSafeHandler} from "@/api/lib/api-handlers"; const createEndpoint = ${wrapper}; export default createEndpoint();`,
      );
      expect(check(sources)).toContainEqual(
        expect.stringContaining("Missing write contract:"),
      );
    }
  });
  test("conditional local route handlers require matching canonical contracts in both branches", () => {
    const sources = fixture("{}");
    sources.set(
      handler,
      'import {createSafeHandler} from "@/api/lib/api-handlers"; const config = {contract: "patch"}; export const createEndpoint = () => createSafeHandler(config, async () => ({})); export default createEndpoint();',
    );
    sources.set(
      "apps/api/src/handlers/example/routes.ts",
      'import endpoint, {createEndpoint} from "./update"; const createRoute = (options) => {const search = options === undefined ? endpoint : createEndpoint(options); return new Elysia().post("/existing", search.handler);}; export const routes = createRoute();',
    );
    expect(enumerate(sources)).toHaveLength(1);
    expect(check(sources)).toEqual([]);
    sources.set(
      "apps/api/src/handlers/example/routes.ts",
      'import endpoint, {createEndpoint} from "./update"; const createRoute = (options) => {const search = options === undefined ? endpoint : opaque(); return new Elysia().post("/existing", search.handler);}; export const routes = createRoute();',
    );
    expect(check(sources)).toContainEqual(
      expect.stringContaining("Missing write contract:"),
    );
  });
  test("explicit wrapper metadata preserves parameter shadows", () => {
    const sources = fixture("{}");
    sources.set(
      handler,
      'import {createSafeHandler} from "@/api/lib/api-handlers"; const injected = "patch"; const createEndpoint = (injected) => createSafeHandler({contract: injected}, async () => ({})); export default createEndpoint();',
    );
    expect(check(sources)).toContainEqual(
      expect.stringContaining("Missing write contract:"),
    );
    sources.set(
      handler,
      'import {createSafeHandler} from "@/api/lib/api-handlers"; const token = {type: "updatedAt", field: "expectedUpdatedAt"}; const createEndpoint = (token) => createSafeHandler({contract: "replace", precondition: token}, async () => ({})); export default createEndpoint();',
    );
    expect(check(sources)).toContainEqual(
      expect.stringContaining("Replace route requires precondition:"),
    );
  });
  test("raw metadata cannot fill a partially resolved canonical wrapper", () => {
    const sources = fixture("{}");
    sources.set(
      handler,
      'import {createSafeHandler} from "@/api/lib/api-handlers"; const createEndpoint = (condition) => condition ? createSafeHandler({contract: "patch"}, async () => ({})) : opaque(); export default createEndpoint();',
    );
    expect(check(sources)).toContainEqual(
      expect.stringContaining("Missing write contract:"),
    );
    sources.set(
      "apps/api/src/lib/write-contract.ts",
      "export const RAW_WRITE_CONTRACTS = {'apps/api/src/handlers/example/routes.ts|POST|/existing': {contract: 'patch'}} as const;",
    );
    expect(() => enumerate(sources)).toThrow(
      "Raw write contract cannot override a safe handler:",
    );
  });
  test("module and local handler name collisions cannot hide local metadata", () => {
    const sources = fixture("{}");
    const routes = "apps/api/src/handlers/example/routes.ts";
    for (const localConfig of [
      '{contract: "replace", precondition: {type: "updatedAt", field: "expectedUpdatedAt"}}',
      "{}",
    ]) {
      sources.set(
        routes,
        `import {createSafeHandler} from "@/api/lib/api-handlers"; const search = createSafeHandler({contract: "patch"}, async () => ({})); const createRoute = () => {const search = createSafeHandler(${localConfig}, async () => ({})); return new Elysia().post("/existing", search.handler);}; export const routes = createRoute();`,
      );
      expect(enumerate(sources)).toHaveLength(1);
      expect(check(sources)).toContainEqual(
        expect.stringContaining("Missing write contract:"),
      );
    }
    sources.set(
      "apps/api/src/lib/write-contract.ts",
      `export const RAW_WRITE_CONTRACTS = {'${routes}|POST|/existing': {contract: 'patch'}} as const;`,
    );
    expect(() => enumerate(sources)).toThrow(
      "Raw write contract cannot override a safe handler:",
    );
  });
  test("multiple local handler candidates stay ambiguous even beside a module binding", () => {
    const sources = fixture("{}");
    sources.set(
      "apps/api/src/handlers/example/routes.ts",
      'import {createSafeHandler} from "@/api/lib/api-handlers"; const search = createSafeHandler({contract: "patch"}, async () => ({})); const unused = () => {const search = opaque(); return search;}; const createRoute = () => {const search = createSafeHandler({}, async () => ({})); return new Elysia().post("/existing", search.handler);}; export const routes = createRoute();',
    );
    expect(enumerate(sources)).toHaveLength(1);
    expect(check(sources)).toContainEqual(
      expect.stringContaining("Missing write contract:"),
    );
  });
  test("the repository graph has no undeclared HTTP surfaces", () => {
    const load = (file: string) =>
      existsSync(path.join(root, file))
        ? readFileSync(path.join(root, file), "utf-8")
        : undefined;
    const registrations = enumerateWriteContracts(load);
    const baseline = v.parse(
      writeContractBaselineSchema,
      JSON.parse(
        readFileSync(
          path.join(root, "scripts/write-contracts-baseline.json"),
          "utf-8",
        ),
      ),
    );
    expect(registrations.length).toBeGreaterThanOrEqual(456);
    expect(
      checkWriteContracts({
        registrations,
        baseline,
        previous: baseline,
        previousRegistrations: [],
        debtIds: readWriteContractDebtIds(load),
      }),
    ).toEqual([]);
  }, 30_000);
});
