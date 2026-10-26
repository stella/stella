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
      enforcementOf(guarded.replace(/enforce\(\{type:[^;]+;/u, "")),
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
          "",
        ),
      ),
    ).toContainEqual(
      expect.stringContaining(
        "Replacement must reach owner enforcement for selectedTextHash",
      ),
    );
  });
});
