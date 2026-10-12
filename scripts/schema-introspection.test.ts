import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  OWNERSHIP,
  SCHEMA_INTROSPECTION,
  withSchemaIntrospection,
  validateOwnership,
} from "./ownership.ts";
import { assessMeasurements, RATCHET_METRICS } from "./ratchet.ts";
import {
  schemaIntrospectionPaths,
  validateSchemaIntrospection,
} from "./schema-introspection.ts";

const FULL_IMPORT = 'import * as schema from "@/api/db/schema";';
const fixture = (sources: Record<string, string>) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "schema-introspection-"));
  const files = {
    "apps/api/src/db/schema.ts": 'export * from "./schema/tables";',
    "apps/api/src/db/schema/tables.ts": "export const tables = {};",
    ...sources,
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return {
    root,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
};

const validate = (
  source: string,
  dependencies: Record<string, string> = {},
) => {
  const file = "apps/api/src/inventory.ts";
  const { root, dispose } = fixture({ [file]: source, ...dependencies });
  try {
    return validateSchemaIntrospection({
      entries: [{ path: file, reason: "Enumerates table metadata." }],
      repoRoot: root,
    });
  } finally {
    dispose();
  }
};

describe("schema-only dependency validation", () => {
  // This scan parses the committed runtime dependency graph, unlike the tiny fixtures.
  test("accepts the complete committed set", () => {
    expect(
      validateSchemaIntrospection({
        entries: SCHEMA_INTROSPECTION,
        repoRoot: path.resolve(import.meta.dir, ".."),
      }),
    ).toEqual([]);
  }, 30_000);

  test("accepts table enumeration and type-only database references", () => {
    expect(
      validate(
        `${FULL_IMPORT}\nimport type { Db } from "@/api/db/root";\nObject.values(schema);`,
      ),
    ).toEqual([]);
  });

  for (const method of [
    "select",
    "selectDistinct",
    "insert",
    "update",
    "delete",
    "execute",
    "transaction",
    "query",
    "findMany",
  ]) {
    test(`reports ${method} for any injected receiver name`, () => {
      const problems = validate(
        `${FULL_IMPORT}\nexport const inventory = (connection: any) => connection["${method}"](schema.tables);`,
      );
      expect(problems).toContain(
        `apps/api/src/inventory.ts: database operation in apps/api/src/inventory.ts: ${method}`,
      );
    });
  }

  test("resolves local callback maps and rejects unresolved computed calls", () => {
    expect(
      validate(
        `${FULL_IMPORT}\nconst callbacks = { tables: () => Object.values(schema) } as const; callbacks[key]();`,
      ),
    ).toEqual([]);
    expect(
      validate(
        `${FULL_IMPORT}\nexport const inventory = (connection: any, method: string) => connection[method]();`,
      ),
    ).toContain(
      "apps/api/src/inventory.ts: unresolved runtime call in apps/api/src/inventory.ts",
    );
  });

  test("distinguishes error query metadata and console dispatch from database calls", () => {
    expect(
      validate(
        `${FULL_IMPORT}\nconst error = { query: "shape", params: [] }; const shape = error["query"]; console[level](shape);`,
      ),
    ).toEqual([]);
    const queryAliases = [
      "const query = connection.query; query();",
      "const query = connection.query; (query)();",
      "const query = connection.query; const run = query; run();",
      "const query = ((connection.query)); const middle = (query); const run = ((middle)); run();",
      "((connection.query))();",
      "const query = connection.query; let run; run = query; run();",
      "let query; query = connection.query; const run = query; run();",
    ];
    for (const source of queryAliases) {
      expect(validate(`${FULL_IMPORT}\n${source}`)).toContain(
        "apps/api/src/inventory.ts: database operation in apps/api/src/inventory.ts: query",
      );
    }
    expect(
      validate(
        `${FULL_IMPORT}\nconst query = error.query; const run = query; function invoke(run: () => void) { run(); }`,
      ),
    ).toEqual([]);
    expect(
      validate(
        `${FULL_IMPORT}\nconst run = (console: Record<string, () => void>, level: string) => console[level]();`,
      ),
    ).toContain(
      "apps/api/src/inventory.ts: unresolved runtime call in apps/api/src/inventory.ts",
    );
  });

  test("reports method aliases and malformed runtime sources", () => {
    expect(
      validate(
        `${FULL_IMPORT}\nexport const inventory = (connection: any) => { const read = connection.select; return read(); };`,
      ),
    ).toContain(
      "apps/api/src/inventory.ts: database operation in apps/api/src/inventory.ts: select",
    );
    expect(
      validate(
        `${FULL_IMPORT}\nexport const inventory = ({select: read}: any) => read();`,
      ),
    ).toContain(
      "apps/api/src/inventory.ts: database operation in apps/api/src/inventory.ts: select",
    );
    expect(validate(`${FULL_IMPORT}\nconnection.select(`)).toContain(
      "apps/api/src/inventory.ts: cannot parse runtime dependency: apps/api/src/inventory.ts",
    );
  });

  test("reports database bindings even when renamed", () => {
    expect(
      validate(
        `${FULL_IMPORT}\nimport { rootDb as connection } from "./db/root";`,
      ),
    ).toContain(
      "apps/api/src/inventory.ts: database handle import in apps/api/src/inventory.ts: ./db/root",
    );
  });

  test("walks runtime imports, re-exports and import cycles", () => {
    expect(
      validate(`${FULL_IMPORT}\nimport { inventory } from "./helper";`, {
        "apps/api/src/helper.ts": 'export * from "./nested";',
        "apps/api/src/nested.ts":
          'import "./helper"; export const inventory = (connection: any) => connection.select();',
      }),
    ).toContain(
      "apps/api/src/inventory.ts: database operation in apps/api/src/nested.ts: select",
    );
  });

  test("walks literal dynamic imports and refuses unresolved imports", () => {
    expect(
      validate(`${FULL_IMPORT}\nawait import("./helper");`, {
        "apps/api/src/helper.ts":
          'import { drizzle } from "drizzle-orm/pglite";',
      }),
    ).toContain(
      "apps/api/src/inventory.ts: database handle import in apps/api/src/helper.ts: drizzle-orm/pglite",
    );
    expect(validate(`${FULL_IMPORT}\nawait import(moduleName);`)).toContain(
      "apps/api/src/inventory.ts: unresolved runtime import in apps/api/src/inventory.ts",
    );
    expect(validate(`${FULL_IMPORT}\nimport "./absent";`)).toContain(
      "apps/api/src/inventory.ts: unresolved runtime import in apps/api/src/inventory.ts: ./absent",
    );
  });

  test("reports stale named-only schema imports", () => {
    expect(validate('import { tables } from "@/api/db/schema";')).toContain(
      "apps/api/src/inventory.ts: stale schema introspection entry: no full-schema import or re-export",
    );
  });

  test("distinguishes bound collection and hash operations", () => {
    expect(
      validate(
        `${FULL_IMPORT}\nimport { createHash } from "node:crypto"; const keys = new Map(); keys.delete("a"); createHash("sha256").update("a"); const hash = new Bun.CryptoHasher("sha256"); hash.update("a"); const localHash = () => new Bun.CryptoHasher("sha256"); localHash().update("a");`,
      ),
    ).toEqual([]);
    expect(
      validate(`${FULL_IMPORT}\nconst keys = new Map(); keys.select();`),
    ).toContain(
      "apps/api/src/inventory.ts: database operation in apps/api/src/inventory.ts: select",
    );
  });

  for (const runtime of ["bun", "node"]) {
    test(`recognizes aliased SHA-256 ${runtime} owners without permitting database calls`, () => {
      const dependencies = {
        "node_modules/@stll/sha256/package.json": JSON.stringify({
          name: "@stll/sha256",
          exports: { [`./${runtime}`]: `./${runtime}.ts` },
        }),
        [`node_modules/@stll/sha256/${runtime}.ts`]:
          "export const createSha256 = () => new Bun.CryptoHasher('sha256');",
      };
      const imported = `${FULL_IMPORT}\nimport { createSha256 as makeHash } from "@stll/sha256/${runtime}";`;
      expect(
        validate(
          `${imported} const hash = makeHash(); hash.update("a"); makeHash().update("b");`,
          dependencies,
        ),
      ).toEqual([]);
      expect(
        validate(`${imported} makeHash().select();`, dependencies),
      ).toContain(
        "apps/api/src/inventory.ts: database operation in apps/api/src/inventory.ts: select",
      );
    });
  }

  test("does not exempt local factories returning database receivers", () => {
    expect(
      validate(
        `${FULL_IMPORT}\nconst connection = {}; const createSha256 = () => connection; createSha256().update(schema.tables);`,
      ),
    ).toContain(
      "apps/api/src/inventory.ts: database operation in apps/api/src/inventory.ts: update",
    );
  });

  test("does not trust a factory solely by its name", () => {
    expect(
      validate(
        `${FULL_IMPORT}\nimport { createSha256 } from "./connection"; createSha256().update(schema.tables);`,
        {
          "apps/api/src/connection.ts":
            "export const createSha256 = () => ({});",
        },
      ),
    ).toContain(
      "apps/api/src/inventory.ts: database operation in apps/api/src/inventory.ts: update",
    );
  });

  test("requires exact files, distinct membership and reasons", () => {
    const { root, dispose } = fixture({});
    try {
      const entry = { path: "apps/api/src/db/schema.ts", reason: "" };
      const problems = validateSchemaIntrospection({
        entries: [
          entry,
          entry,
          { path: "apps/api/src/db/", reason: "metadata" },
        ],
        repoRoot: root,
      });
      expect(problems).toContain(
        "apps/api/src/db/schema.ts: schema introspection needs a reason",
      );
      expect(problems).toContain(
        "apps/api/src/db/schema.ts: duplicate schema introspection entry",
      );
      expect(problems).toContain(
        "apps/api/src/db/: schema introspection must name an existing file",
      );
    } finally {
      dispose();
    }
  });
});

test("every schema owner inherits exactly the shared set once", () => {
  const declared = SCHEMA_INTROSPECTION.map(({ path: file }) => file);
  for (const entry of OWNERSHIP) {
    if (
      entry.enforcement.kind !== "import" ||
      !entry.enforcement.specifiers.some((specifier) =>
        specifier.startsWith("@/api/db/schema"),
      )
    ) {
      continue;
    }
    for (const file of declared) {
      expect(
        entry.enforcement.allowed.filter(
          ({ path: allowed }) => allowed === file,
        ),
      ).toHaveLength(1);
    }
  }
  const entry = {
    id: "inventory",
    capability: "Table declarations",
    owner: ["apps/api/src/owner.ts"],
    summary: "Owns a table.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/db/schema/new-domain"],
      names: ["newTable"],
      allowed: [],
    },
  } as const;
  expect(withSchemaIntrospection(entry).enforcement).toEqual({
    ...entry.enforcement,
    allowed: SCHEMA_INTROSPECTION,
  });
  expect(
    withSchemaIntrospection({
      ...entry,
      enforcement: { ...entry.enforcement, specifiers: ["@/api/lib/other"] },
    }),
  ).toEqual({
    ...entry,
    enforcement: { ...entry.enforcement, specifiers: ["@/api/lib/other"] },
  });
});

test("path measurement derives legacy exceptions and shared membership", () => {
  const legacy =
    'export const OWNERSHIP = [{enforcement:{kind:"import",specifiers:["@/api/db/schema/entities"],allowed:[{path:"first.ts",reason:"metadata"},{path:"db/",reason:"declarations"}]}},{enforcement:{kind:"import",specifiers:["@/api/lib/other"],allowed:[{path:"other.ts",reason:"other"}]}}];';
  expect(schemaIntrospectionPaths(legacy)).toEqual(["first.ts"]);
  expect(
    schemaIntrospectionPaths(
      `export const SCHEMA_INTROSPECTION = [{path:"second.ts",reason:"metadata"}];${
        legacy
      }`,
    ),
  ).toEqual(["second.ts"]);
  expect(
    schemaIntrospectionPaths(
      readFileSync(new URL("ownership.ts", import.meta.url), "utf-8"),
    ),
  ).toEqual(SCHEMA_INTROSPECTION.map(({ path: file }) => file));
});

test("membership changes are gated per file and removals are free", () => {
  const metric = RATCHET_METRICS.find(
    ({ id }) => id === "schema-introspection-files",
  );
  if (metric === undefined) {
    throw new TypeError("Missing schema introspection metric");
  }
  const baseline = {
    [metric.id]: { count: 2, files: { "first.ts": 1, "second.ts": 1 } },
  };
  expect(
    assessMeasurements({
      metrics: [metric],
      baseline,
      current: { [metric.id]: { count: 1, files: { "first.ts": 1 } } },
    }).allowed,
  ).toBe(true);
  expect(
    assessMeasurements({
      metrics: [metric],
      baseline,
      current: {
        [metric.id]: { count: 2, files: { "first.ts": 1, "third.ts": 1 } },
      },
    }).allowed,
  ).toBe(false);
  expect(() =>
    schemaIntrospectionPaths(
      "export const SCHEMA_INTROSPECTION = otherEntries;",
    ),
  ).toThrow("SCHEMA_INTROSPECTION must be a literal array");
});

test("schema ownership resolves relative specifiers and keeps mixed modules separate", () => {
  const entry = {
    id: "inventory",
    capability: "Table declarations",
    owner: ["scripts/ownership.ts"],
    summary: "Owns a table.",
    enforcement: {
      kind: "import",
      specifiers: ["../apps/api/src/db/schema/entities.ts"],
      allowed: [],
    },
  } as const;
  expect(withSchemaIntrospection(entry).enforcement).toEqual({
    ...entry.enforcement,
    allowed: SCHEMA_INTROSPECTION,
  });
  expect(
    validateOwnership(
      [
        {
          ...entry,
          enforcement: {
            ...entry.enforcement,
            specifiers: ["@/api/db/schema", "@/api/lib/other"],
          },
        },
      ],
      path.resolve(import.meta.dir, ".."),
    ),
  ).toEqual([
    "inventory: schema imports require a separate ownership entry from other modules",
  ]);
});
