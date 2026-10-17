import { describe, expect, test } from "bun:test";

import {
  baselineProblems,
  coversTarget,
  describeRollbackIncompatibility,
  findRollbackIncompatibilities,
  loadBaseline,
  migrationExists,
  parseCatalog,
} from "./migration-rollback-compatibility";

type ColumnSpec = {
  type?: string;
  not_null?: boolean;
  default?: string | null;
  identity?: string;
  comment?: string | null;
};

type CatalogSpec = {
  tables?: Record<string, { comment?: string | null }>;
  columns?: Record<string, ColumnSpec>;
  constraints?: Record<
    string,
    { table: string; definition: string; type: string; columns: string[] }
  >;
  uniqueIndexes?: Record<
    string,
    { table: string; definition: string; columns: string[] }
  >;
  enums?: Record<string, string[]>;
  functions?: Record<string, string>;
  ledger?: string[];
};

// Keys follow scripts/migration-catalog.ts: dotted schema-qualified names.
const catalog = (spec: CatalogSpec) =>
  parseCatalog({
    tables: Object.fromEntries(
      Object.entries(spec.tables ?? {}).map(([name, { comment = null }]) => [
        `public.${name}`,
        { schema: "public", name, kind: "r", comment },
      ]),
    ),
    views: {},
    columns: Object.fromEntries(
      Object.entries(spec.columns ?? {}).map(([key, column]) => {
        const [table = "", name = ""] = key.split(".");
        return [
          `public.${key}`,
          {
            schema: "public",
            table,
            name,
            type: column.type ?? "text",
            not_null: column.not_null ?? false,
            default: column.default ?? null,
            identity: column.identity ?? "",
            generated: "",
            comment: column.comment ?? null,
          },
        ];
      }),
    ),
    constraints: Object.fromEntries(
      Object.entries(spec.constraints ?? {}).map(([name, row]) => [
        `public.${row.table}.${name}`,
        { schema: "public", name, ...row },
      ]),
    ),
    indexes: Object.fromEntries(
      Object.entries(spec.uniqueIndexes ?? {}).map(([name, row]) => [
        `public.${row.table}.${name}`,
        {
          schema: "public",
          name,
          unique: true,
          constraint_backed: false,
          ...row,
        },
      ]),
    ),
    functions: Object.fromEntries(
      Object.entries(spec.functions ?? {}).map(([name, args]) => [
        `public.${name}.${args}`,
        { schema: "public", name, arguments: args },
      ]),
    ),
    enums: spec.enums ?? {},
    ledger: spec.ledger ?? [],
  });

const documents = {
  tables: { documents: {} },
  columns: {
    "documents.id": { not_null: true },
    "documents.title": {},
    "documents.status": { not_null: true, default: "'draft'::text" },
  },
} satisfies CatalogSpec;

const typesOf = (base: CatalogSpec, upgraded: CatalogSpec): string[] =>
  findRollbackIncompatibilities({
    base: catalog(base),
    upgraded: catalog(upgraded),
  }).map((finding) => finding.type);

describe("findRollbackIncompatibilities", () => {
  test("an unchanged or purely additive schema is compatible", () => {
    expect(typesOf(documents, documents)).toEqual([]);
    expect(
      typesOf(documents, {
        tables: { ...documents.tables, drafts: {} },
        columns: {
          ...documents.columns,
          "documents.note": {},
          "documents.rank": { not_null: true, default: "0" },
          "documents.seq": { not_null: true, identity: "a" },
          "drafts.id": { not_null: true },
        },
        constraints: {
          documents_rank_check: {
            table: "documents",
            definition: "CHECK (rank >= 0)",
            type: "c",
            columns: ["rank"],
          },
        },
        enums: { "public.document_kind": ["memo"] },
      }),
    ).toEqual([]);
  });

  test("names each change the base release cannot tolerate", () => {
    expect(
      typesOf(
        {
          ...documents,
          tables: { ...documents.tables, notes: {} },
          columns: {
            ...documents.columns,
            "documents.size": { type: "integer" },
          },
          enums: { "public.document_kind": ["memo", "brief"] },
          functions: { document_is_live: "doc_id text" },
        },
        {
          tables: documents.tables,
          columns: {
            "documents.id": { not_null: true },
            "documents.title": { not_null: true },
            "documents.status": { not_null: true },
            "documents.size": { type: "bigint" },
            "documents.owner_id": { not_null: true },
          },
          constraints: {
            documents_title_check: {
              table: "documents",
              definition: "CHECK (title <> ''::text) NOT VALID",
              type: "c",
              columns: ["title"],
            },
          },
          uniqueIndexes: {
            documents_title_key: {
              table: "documents",
              definition:
                "CREATE UNIQUE INDEX documents_title_key ON public.documents USING btree (title)",
              columns: ["title"],
            },
          },
          enums: { "public.document_kind": ["memo"] },
        },
      ).toSorted(),
    ).toEqual(
      [
        "relation-removed",
        "not-null-added",
        "default-removed",
        "column-type-changed",
        "required-column-added",
        "constraint-added",
        "unique-index-added",
        "enum-value-removed",
        "routine-removed",
      ].toSorted(),
    );
  });

  test("a dropped or renamed column is removed", () => {
    expect(
      typesOf(documents, {
        tables: documents.tables,
        columns: {
          "documents.id": { not_null: true },
          "documents.name": {},
          "documents.status": { not_null: true, default: "'draft'::text" },
        },
      }),
    ).toEqual(["column-removed"]);
  });

  test("validating a NOT VALID constraint or widening a value list is compatible", () => {
    const status = (definition: string) => ({
      ...documents,
      constraints: {
        documents_status_check: {
          table: "documents",
          definition,
          type: "c",
          columns: ["status"],
        },
      },
    });
    const draftOnly =
      "CHECK (status = ANY (ARRAY['draft'::text, 'final'::text])) NOT VALID";
    expect(
      typesOf(
        status(draftOnly),
        status("CHECK (status = ANY (ARRAY['draft'::text, 'final'::text]))"),
      ),
    ).toEqual([]);
    expect(
      typesOf(
        status(draftOnly),
        status(
          "CHECK (status IS NULL OR (status = ANY (ARRAY['draft'::text, 'final'::text, 'it''s'::text])))",
        ),
      ),
    ).toEqual([]);
    expect(
      typesOf(
        status(draftOnly),
        status("CHECK (status = ANY (ARRAY['draft'::text, 'archived'::text]))"),
      ),
    ).toEqual(["constraint-changed"]);
    expect(
      typesOf(
        status(
          "CHECK (status IS NULL OR (status = ANY (ARRAY['draft'::text])))",
        ),
        status("CHECK (status = ANY (ARRAY['draft'::text, 'final'::text]))"),
      ),
    ).toEqual(["constraint-changed"]);
  });

  test("a retired table or column is unused by the base release", () => {
    expect(
      typesOf(
        {
          tables: {
            ...documents.tables,
            drafts: { comment: "stella:retired - replaced by documents" },
          },
          columns: {
            ...documents.columns,
            "documents.legacy": { not_null: true, comment: "stella:retired" },
            "drafts.id": { not_null: true },
          },
        },
        documents,
      ),
    ).toEqual([]);
    expect(
      typesOf(
        {
          ...documents,
          columns: {
            ...documents.columns,
            "documents.legacy": { comment: "stella:retiredish" },
          },
        },
        documents,
      ),
    ).toEqual(["column-removed"]);
  });

  test("a unique index over columns the base release never writes is compatible", () => {
    expect(
      typesOf(documents, {
        ...documents,
        columns: { ...documents.columns, "documents.slug": {} },
        uniqueIndexes: {
          documents_slug_key: {
            table: "documents",
            definition:
              "CREATE UNIQUE INDEX documents_slug_key ON public.documents USING btree (slug)",
            columns: ["slug"],
          },
        },
      }),
    ).toEqual([]);
  });
});

describe("acknowledgement coverage", () => {
  const column = {
    type: "column",
    schema: "public",
    table: "documents",
    column: "title",
  } as const;
  const constraint = {
    type: "constraint",
    schema: "public",
    table: "documents",
    name: "documents_title_check",
  } as const;
  const relation = {
    type: "relation",
    schema: "public",
    name: "documents",
  } as const;

  test("a table covers its columns and constraints", () => {
    expect(coversTarget(relation, column)).toBe(true);
    expect(coversTarget(relation, constraint)).toBe(true);
  });

  test("a named constraint covers only itself; an unnamed one its table's", () => {
    expect(coversTarget(constraint, constraint)).toBe(true);
    expect(
      coversTarget(constraint, {
        ...constraint,
        name: "documents_other_check",
      }),
    ).toBe(false);
    expect(coversTarget({ ...constraint, name: null }, constraint)).toBe(true);
    expect(coversTarget(constraint, column)).toBe(false);
    expect(coversTarget(column, relation)).toBe(false);
  });
});

test("describes a finding with the object and the base release", () => {
  expect(
    describeRollbackIncompatibility(
      {
        type: "column-removed",
        column: { schema: "public", table: "documents", column: "title" },
      },
      "v1.2.3",
    ),
  ).toBe(
    "public.documents.title: column removed or renamed; v1.2.3 selects and inserts it",
  );
});

describe("baselineProblems", () => {
  const target = {
    type: "column",
    schema: "public",
    table: "documents",
    column: "title",
  } as const;
  const problemsFor = (migration: string, inBase: boolean) =>
    baselineProblems({
      entries: [{ migration, target }],
      baseMigrations: new Set(inBase ? [migration] : []),
      baseRelease: "v1.2.3",
      exists: (name) => name !== "20261001000000_missing",
    });

  test("keeps an entry until its migration ships in the promoted release", () => {
    expect(
      problemsFor("20261010005100_standard_skill_resource_folders", false),
    ).toEqual([]);
    expect(
      problemsFor("20261010005100_standard_skill_resource_folders", true),
    ).toEqual([
      expect.stringContaining("v1.2.3 already includes it; remove the entry"),
    ]);
  });

  test("the committed baseline names only existing migrations before the cutoff", async () => {
    expect(
      baselineProblems({
        entries: await loadBaseline(),
        baseMigrations: new Set(),
        baseRelease: "the promoted release",
        exists: migrationExists,
      }),
    ).toEqual([]);
  });

  test("rejects entries for later or unknown migrations", () => {
    expect(problemsFor("20991231000000_later", false)).toEqual([
      expect.stringContaining(
        "acknowledge rollback-contract in the migration instead",
      ),
    ]);
    expect(problemsFor("20261001000000_missing", false)).toEqual([
      expect.stringContaining("no such migration"),
    ]);
  });
});
