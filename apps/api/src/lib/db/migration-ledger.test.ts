import { describe, expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getMigrationsToRun } from "drizzle-orm/migrator.utils";
import fc from "fast-check";
import nodePath from "node:path";

import { propertyConfig } from "@stll/property-testing";

import migrationAliasInventory from "./migration-alias-inventory.json";
import {
  findMalformedRequiresLines,
  findSortUnstableNames,
  parseRequiresHeader,
  planLedgerAdoption,
  validateLedger,
  validateRequires,
} from "./migration-ledger";

const MIGRATIONS_DIR = nodePath.resolve(import.meta.dir, "../../../drizzle");
const A = "20260929100000_first";
const B = "20260929110000_second";
const C = "20260929120000_third";

const migration = ({
  name,
  hash = name,
  folderMillis = 1,
  sql = "SELECT 1;",
}: {
  name: string;
  hash?: string;
  folderMillis?: number;
  sql?: string;
}) => ({ name, hash, folderMillis, sql: [sql], bps: true });

const receipt = ({
  id,
  hash,
  name = null,
  created_at = 1,
}: {
  id: number;
  hash: string;
  name?: string | null;
  created_at?: string | number | bigint | null;
}) => ({ id, hash, name, created_at });

describe("migration ledger adoption", () => {
  test("rejects a NULL name that no bundled or inventoried hash explains", () => {
    expect(
      validateLedger({
        receipts: [receipt({ id: 1, hash: "unrecognized" })],
        bundle: [migration({ name: A, hash: "current" })],
        inventory: [],
      }),
    ).toContainEqual({ type: "null-name", rowId: 1 });
  });

  test("rejects two receipts with the same name", () => {
    expect(
      validateLedger({
        receipts: [
          receipt({ id: 1, name: A, hash: "current" }),
          receipt({ id: 2, name: A, hash: "current" }),
        ],
        bundle: [migration({ name: A, hash: "current" })],
        inventory: [],
      }),
    ).toContainEqual({
      type: "duplicate-name",
      name: A,
      rowIds: [1, 2],
    });
  });

  test("does not hash-map an unknown named receipt to identical bundled SQL", () => {
    const bundledName = "20260707100000_drop_prompt_shortcuts";
    const recordedName = "20260707130000_drop_prompt_shortcuts";
    const row = receipt({ id: 1, name: recordedName, hash: "same-sql-hash" });
    const bundle = [migration({ name: bundledName, hash: row.hash })];
    expect(planLedgerAdoption({ rows: [row], bundle, inventory: [] })).toEqual([
      { type: "unknown", receipt: row },
    ]);
    expect(
      validateLedger({ receipts: [row], bundle, inventory: [] }),
    ).toContainEqual({
      type: "unknown-name",
      rowId: 1,
      name: recordedName,
      pending: true,
    });
  });

  test("reports whether an unknown name leaves SQL pending, without choosing a policy", () => {
    const unknown = receipt({ id: 2, name: C, hash: "unknown" });
    const bundle = [migration({ name: A }), migration({ name: B })];
    expect(
      validateLedger({
        receipts: [receipt({ id: 1, name: A, hash: A }), unknown],
        bundle,
        inventory: [],
      }),
    ).toContainEqual({
      type: "unknown-name",
      rowId: 2,
      name: C,
      pending: true,
    });
    expect(
      validateLedger({
        receipts: [
          receipt({ id: 1, name: A, hash: A }),
          receipt({ id: 3, name: B, hash: B }),
          unknown,
        ],
        bundle,
        inventory: [],
      }),
    ).toContainEqual({
      type: "unknown-name",
      rowId: 2,
      name: C,
      pending: false,
    });
  });

  test("rejects a named receipt whose hash is outside the alias closure", () => {
    const inventory = [{ fileName: A, priorHash: "prior", newHash: "current" }];
    expect(
      validateLedger({
        receipts: [receipt({ id: 1, name: A, hash: "other" })],
        bundle: [migration({ name: A, hash: "current" })],
        inventory,
      }),
    ).toContainEqual({
      type: "hash-mismatch",
      rowId: 1,
      name: A,
      hash: "other",
      pending: false,
    });
    expect(
      validateLedger({
        receipts: [receipt({ id: 1, name: A, hash: "prior" })],
        bundle: [migration({ name: A, hash: "current" })],
        inventory,
      }),
    ).toEqual([]);
    expect(
      validateLedger({
        receipts: [receipt({ id: 1, name: A, hash: "orphan" })],
        bundle: [migration({ name: A, hash: "current" })],
        inventory: [
          ...inventory,
          { fileName: A, priorHash: "orphan", newHash: "unrelated" },
        ],
      }),
    ).toContainEqual({
      type: "hash-mismatch",
      rowId: 1,
      name: A,
      hash: "orphan",
      pending: false,
    });
  });

  test("adopts by hash and uses the timestamp only to break hash ties", () => {
    const bundle = [
      migration({ name: A, hash: "shared", folderMillis: 100 }),
      migration({ name: B, hash: "shared", folderMillis: 200 }),
      migration({ name: C, hash: "other", folderMillis: 200 }),
    ];
    expect(
      planLedgerAdoption({
        rows: [
          receipt({ id: 1, hash: "shared", created_at: 200 }),
          receipt({ id: 2, hash: "other", created_at: 100 }),
          receipt({ id: 3, name: A, hash: "other", created_at: 200 }),
        ],
        bundle,
        inventory: [],
      }),
    ).toEqual([
      {
        type: "mapped",
        receipt: receipt({ id: 1, hash: "shared", created_at: 200 }),
        name: B,
        matchedBy: "timestamp",
      },
      {
        type: "mapped",
        receipt: receipt({ id: 2, hash: "other", created_at: 100 }),
        name: C,
        matchedBy: "hash",
      },
      {
        type: "mapped",
        receipt: receipt({ id: 3, name: A, hash: "other", created_at: 200 }),
        name: A,
        matchedBy: "name",
      },
    ]);
  });

  test("reports ambiguous hash adoption when no timestamp selects one folder", () => {
    const bundle = [
      migration({ name: A, hash: "shared", folderMillis: 100 }),
      migration({ name: B, hash: "shared", folderMillis: 200 }),
    ];
    expect(
      validateLedger({
        receipts: [receipt({ id: 1, hash: "shared", created_at: 300 })],
        bundle,
        inventory: [],
      }),
    ).toContainEqual({
      type: "ambiguous-adoption",
      rowId: 1,
      candidateNames: [A, B],
    });
  });

  test("adopts every predecessor in a chain ending at the bundled hash", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), {
          minLength: 1,
          maxLength: 8,
        }),
        (values) => {
          const firstHash = "hash-initial";
          const currentHash = "hash-current";
          let priorHash = firstHash;
          const inventory = values.map((value, index) => {
            const newHash =
              index === values.length - 1
                ? currentHash
                : `hash-${index}-${value}`;
            const alias = { fileName: A, priorHash, newHash };
            priorHash = newHash;
            return alias;
          });
          expect(
            planLedgerAdoption({
              rows: [receipt({ id: 1, hash: firstHash })],
              bundle: [migration({ name: A, hash: currentHash })],
              inventory,
            }),
          ).toEqual([
            {
              type: "mapped",
              receipt: receipt({ id: 1, hash: firstHash }),
              name: A,
              matchedBy: "hash",
            },
          ]);
        },
      ),
      propertyConfig(),
    );
  });

  test("pending status agrees with Drizzle in the supplied migration order", () => {
    const bundle = readMigrationFiles({
      migrationsFolder: MIGRATIONS_DIR,
    }).slice(0, 3);
    fc.assert(
      fc.property(
        fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()),
        (applied) => {
          const known = bundle.flatMap((item, index) =>
            applied[index]
              ? [
                  receipt({
                    id: index + 1,
                    name: item.name,
                    hash: item.hash,
                  }),
                ]
              : [],
          );
          const drizzlePending = getMigrationsToRun({
            localMigrations: bundle,
            dbMigrations: known.map(({ id, hash, name }) => ({
              id,
              hash,
              created_at: "1",
              name,
            })),
          });
          expect(drizzlePending.map(({ name }) => name)).toEqual(
            bundle
              .filter((_, index) => !applied[index])
              .map(({ name }) => name),
          );
          const violations = validateLedger({
            receipts: [...known, receipt({ id: 4, name: C, hash: "unknown" })],
            bundle,
            inventory: migrationAliasInventory,
          });
          expect(
            violations.find(({ type }) => type === "unknown-name"),
          ).toMatchObject({ pending: drizzlePending.length > 0 });
        },
      ),
      propertyConfig(),
    );
  });

  test("the migration ledger design is pinned to Drizzle rc.4", async () => {
    expect(
      await Bun.file(
        nodePath.resolve(
          import.meta.dir,
          "../../../../../node_modules/drizzle-orm/package.json",
        ),
      ).json(),
    ).toMatchObject({ version: "1.0.0-rc.4" });
  });
});

describe("migration dependencies", () => {
  test("parses folder-shaped dependencies in the leading comment block", () => {
    expect(
      parseRequiresHeader(
        `-- introduction\n-- requires: ${A}\n\n-- requires: ${B}\nSELECT 1;`,
      ).dependencies,
    ).toEqual([A, B]);
  });

  test("ignores requires prose without a colon", () => {
    expect(
      parseRequiresHeader("-- requires CREATE INDEX CONCURRENTLY\nSELECT 1;"),
    ).toEqual({ dependencies: [], lines: [] });
  });

  test("the real migration corpus has no dependency headers", async () => {
    const bundle = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
    const headers = bundle.flatMap(({ name, sql }) =>
      parseRequiresHeader(
        sql.join("--> statement-breakpoint"),
      ).dependencies.map((dependency) => ({ name, dependency })),
    );
    expect(headers).toEqual([]);
  });

  test("historical billing prose is ignored by the parser but flagged for a new file", async () => {
    const sqlText = await Bun.file(
      nodePath.join(
        MIGRATIONS_DIR,
        "20260905131000_billing_true_minor_units",
        "migration.sql",
      ),
    ).text();
    expect(sqlText).toContain(
      "-- requires: the rescale writes values `integer` cannot hold.",
    );
    expect(parseRequiresHeader(sqlText).dependencies).toEqual([]);
    expect(findMalformedRequiresLines(sqlText)).toContainEqual({
      type: "malformed-requires",
      line: 31,
      value: "the rescale writes values `integer` cannot hold.",
    });
  });

  test("rejects a folder-shaped dependency after the first statement", () => {
    const sqlText = `SELECT 1;\n-- requires: ${A}`;
    expect(parseRequiresHeader(sqlText).dependencies).toEqual([]);
    expect(findMalformedRequiresLines(sqlText)).toEqual([
      { type: "misplaced-requires", line: 2, value: A },
    ]);
  });

  test("reports an invalid timestamp in a newly added header", () => {
    expect(
      findMalformedRequiresLines("-- requires: 2026092910000_first\nSELECT 1;"),
    ).toEqual([
      {
        type: "malformed-requires",
        line: 1,
        value: "2026092910000_first",
      },
    ]);
  });

  test("recognizes indented headers and reports indented malformed lines", () => {
    expect(
      parseRequiresHeader(`  -- requires: ${A}\nSELECT 1;`).dependencies,
    ).toEqual([A]);
    expect(
      findMalformedRequiresLines(
        "  -- requires: 2026092910000_first\nSELECT 1;",
      ),
    ).toEqual([
      {
        type: "malformed-requires",
        line: 1,
        value: "2026092910000_first",
      },
    ]);
  });

  test("accepts a dependency on an earlier pending migration", () => {
    expect(
      validateRequires({
        bundle: [
          migration({ name: A }),
          migration({ name: B, sql: `-- requires: ${A}\nSELECT 2;` }),
        ],
        appliedNames: new Set(),
      }),
    ).toEqual([]);
  });

  test("rejects a pending dependency that follows its dependent", () => {
    const bundle = [
      migration({ name: A, sql: `-- requires: ${B}\nSELECT 1;` }),
      migration({ name: B }),
    ];
    expect(
      validateRequires({ bundle, appliedNames: new Set() }),
    ).toContainEqual({ type: "requires-order", name: A, dependency: B });
    expect(validateRequires({ bundle, appliedNames: new Set([B]) })).toEqual(
      [],
    );
  });

  test("rejects a missing dependency", () => {
    expect(
      validateRequires({
        bundle: [migration({ name: A, sql: `-- requires: ${B}\nSELECT 1;` })],
        appliedNames: new Set(),
      }),
    ).toContainEqual({ type: "requires-missing", name: A, dependency: B });
  });

  test("rejects self dependencies and cycles", () => {
    const violations = validateRequires({
      bundle: [
        migration({ name: A, sql: `-- requires: ${B}\nSELECT 1;` }),
        migration({ name: B, sql: `-- requires: ${A}\nSELECT 1;` }),
        migration({ name: C, sql: `-- requires: ${C}\nSELECT 1;` }),
      ],
      appliedNames: new Set(),
    });
    expect(violations).toContainEqual({ type: "requires-self", name: C });
    expect(violations).toContainEqual({
      type: "requires-cycle",
      cycle: [A, B, A],
    });
  });

  test("detects a new name whose Drizzle and codepoint positions differ", () => {
    const bundle = [
      migration({ name: "20260930000000_a" }),
      migration({ name: "20260930000000-b" }),
    ];
    expect(
      findSortUnstableNames({
        bundle,
        addedNames: new Set(["20260930000000_a"]),
      }),
    ).toEqual(["20260930000000_a"]);
  });
});
