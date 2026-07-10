// Passive regression fixture for `require-tenant-scope/require-tenant-scope`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag (a tenant-owned-table read with no `where` at all). If the
// rule regresses, the matching disable goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. The cases
// WITHOUT a disable must NOT be flagged; a false positive there fails the
// same run.

declare const tx: {
  query: {
    entities: {
      findMany: (options?: unknown) => unknown;
      findFirst: (options?: unknown) => unknown;
    };
    documentTypes: {
      findMany: (options?: unknown) => unknown;
    };
  };
  select: (columns?: unknown) => {
    from: (table: unknown) => {
      where: (condition: unknown) => unknown;
      leftJoin: (
        table: unknown,
        on: unknown,
      ) => { where: (condition: unknown) => unknown };
      orderBy: (order: unknown) => unknown;
    };
  };
};
declare const entities: unknown;
declare const documentTypes: unknown;
declare const nonTenantTable: unknown;
declare const condition: unknown;
declare const order: unknown;
declare const opts: unknown;

// --- Cases the rule MUST flag ---

// `findMany` with no options at all.
// oxlint-disable-next-line require-tenant-scope/require-tenant-scope
export const findManyNoOptions = tx.query.entities.findMany();

// `findMany` options without a `where` key.
// oxlint-disable-next-line require-tenant-scope/require-tenant-scope
export const findManyNoWhere = tx.query.entities.findMany({
  orderBy: order,
});

// `findFirst` with no options at all.
// oxlint-disable-next-line require-tenant-scope/require-tenant-scope
export const findFirstNoOptions = tx.query.entities.findFirst();

// A select-builder chain on a tenant table with no `.where(` anywhere.
export const selectNoWhere = tx
  .select({ id: 1 })
  // oxlint-disable-next-line require-tenant-scope/require-tenant-scope
  .from(entities)
  .orderBy(order);

// --- Cases the rule MUST NOT flag ---

// `findFirst` with an explicit `where`.
export const findFirstWithWhere = tx.query.entities.findFirst({
  where: condition,
});

// `findMany` with an explicit `where`; the rule does not verify the
// predicate actually references the tenant column.
export const findManyWithWhere = tx.query.entities.findMany({
  where: condition,
});

// Opaque options (a variable, not an object literal) are skipped.
export const findManyOpaqueOptions = tx.query.entities.findMany(opts);

// A select-builder chain with `.where(` present.
export const selectWithWhere = tx
  .select({ id: 1 })
  .from(entities)
  .where(condition);

// `.where(` reached through an intervening `.leftJoin(`.
export const selectWithJoinAndWhere = tx
  .select({ id: 1 })
  .from(entities)
  .leftJoin(documentTypes, condition)
  .where(condition);

// No `.where(` at all, but the tenant scoping is folded into the join's ON
// condition instead -- a join carries a mandatory condition argument, the
// same syntactic role as `.where(...)`, so it satisfies the rule too.
export const selectWithJoinNoWhere = tx
  .select({ id: 1 })
  .from(entities)
  .leftJoin(documentTypes, condition);

// A table not in TENANT_TABLES is out of scope for this rule.
export const selectNonTenantTable = tx
  .select({ id: 1 })
  .from(nonTenantTable)
  .orderBy(order);
