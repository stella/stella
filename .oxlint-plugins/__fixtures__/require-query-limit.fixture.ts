// Passive regression fixture for `require-query-limit/require-query-limit`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag (an unbounded Drizzle read). If the rule regresses, the
// matching disable goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. The cases
// WITHOUT a disable must NOT be flagged; a false positive there fails the
// same run.

declare const tx: {
  query: {
    foo: {
      findMany: (options?: unknown) => unknown;
      findFirst: (options?: unknown) => unknown;
    };
  };
  select: (columns?: unknown) => {
    from: (table: unknown) => {
      where: (condition: unknown) => {
        orderBy: (order: unknown) => {
          limit: (count: number) => unknown;
        };
      };
    };
  };
};
declare const foo: unknown;
declare const columns: unknown;
declare const condition: unknown;
declare const order: unknown;
declare const LIMITS: { messages: number };

// --- Cases the rule MUST flag ---

// `findMany` with no options is unbounded.
// oxlint-disable-next-line require-query-limit/require-query-limit
export const findManyNoOptions = tx.query.foo.findMany();

// `findMany` options without a `limit` key is unbounded.
// oxlint-disable-next-line require-query-limit/require-query-limit
export const findManyNoLimit = tx.query.foo.findMany({ where: condition });

// An ordered select-builder chain with no `.limit(...)`.
export const orderedSelectNoLimit = tx
  .select(columns)
  .from(foo)
  .where(condition)
  // oxlint-disable-next-line require-query-limit/require-query-limit
  .orderBy(order);

// `findFirst` is bounded, but an ordered eager-loaded relation is not.
export const findFirstRelationNoLimit = tx.query.foo.findFirst({
  with: {
    bars: {
      // oxlint-disable-next-line require-query-limit/require-query-limit
      orderBy: order,
    },
  },
});

// A bounded parent (`limit`) can still pull an unbounded ordered relation.
export const findManyBoundedRelationNoLimit = tx.query.foo.findMany({
  limit: LIMITS.messages,
  with: {
    bars: {
      // oxlint-disable-next-line require-query-limit/require-query-limit
      orderBy: order,
    },
  },
});

// Nested `with` is scanned recursively.
export const nestedRelationNoLimit = tx.query.foo.findFirst({
  with: {
    bars: {
      with: {
        bazzes: {
          // oxlint-disable-next-line require-query-limit/require-query-limit
          orderBy: order,
        },
      },
    },
  },
});

// --- Cases the rule MUST NOT flag ---

// `findFirst` with no eager relation is inherently bounded.
export const findFirstBounded = tx.query.foo.findFirst({ where: condition });

// `findMany` carrying an explicit `limit`.
export const findManyWithLimit = tx.query.foo.findMany({
  where: condition,
  limit: LIMITS.messages,
});

// Ordered select chain that is also limited.
export const orderedSelectWithLimit = tx
  .select(columns)
  .from(foo)
  .where(condition)
  .orderBy(order)
  .limit(LIMITS.messages);

// Unordered select is a count / single-row read, not a list.
export const unorderedSelect = tx.select(columns).from(foo).where(condition);

// A `true` relation config is a to-one / load-all relation, left alone.
export const findFirstToOneRelation = tx.query.foo.findFirst({
  with: { bar: true },
});

// An ordered relation that also sets a `limit`.
export const findFirstRelationWithLimit = tx.query.foo.findFirst({
  with: {
    bars: {
      orderBy: order,
      limit: LIMITS.messages,
    },
  },
});
