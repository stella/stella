// Passive regression fixture for `no-db-await-in-loop/no-db-await-in-loop`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag (a DB call awaited inside a loop body through native `await`
// or `yield* Result.await(...)`, or a fan-out via
// `Promise.all(items.map(...))` / `Promise.allSettled(items.map(...))`,
// inline or via a named callback resolved to its local definition, awaited
// or not). If the rule regresses, the matching disable goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. The cases
// WITHOUT a `no-db-await-in-loop` disable must NOT be flagged by it; a false
// positive there fails the same run. (Some flagged cases also carry an
// unrelated `no-await-in-loop` disable — the generic built-in rule already
// fires on any await-in-loop; that is expected and out of scope here.)

declare const db: {
  select: (columns?: unknown) => {
    from: (table: unknown) => { where: (c: unknown) => Promise<unknown> };
  };
  transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
};
declare const tx: {
  insert: (table: unknown) => { values: (v: unknown) => Promise<unknown> };
  select: (columns?: unknown) => {
    from: (table: unknown) => { where: (c: unknown) => Promise<unknown> };
  };
};
declare const safeDb: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
declare const Result: {
  await: <T>(promise: Promise<T>) => AsyncGenerator<never, T, unknown>;
};
declare const items: { id: string }[];
declare const itemsTable: unknown;
declare const idColumn: unknown;
declare const inArray: (col: unknown, values: unknown[]) => unknown;
declare function doInMemoryWork(item: unknown): void;
declare function doInMemoryWorkAsync(item: unknown): Promise<void>;

// --- Cases the rule MUST flag ---

export const forOfLoopAwaitInsert = async () => {
  for (const item of items) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- fixture: intentionally unbatched to exercise the rule
    await tx.insert(itemsTable).values(item);
  }
};

export const whileLoopAwaitSafeDb = async () => {
  let index = 0;
  const results: unknown[] = [];
  while (index < items.length) {
    const currentItem = items[index];
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- fixture: intentionally unbatched to exercise the rule
    const result = await safeDb(async (scopedTx: typeof tx) => {
      const inserted = await scopedTx.insert(itemsTable).values(currentItem);
      return inserted;
    });
    results.push(result);
    index += 1;
  }
  return results;
};

export const forOfLoopResultAwaitSafeDb = async function* () {
  for (const item of items) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: safe handlers await DB results through delegated Result generators
    yield* Result.await(
      safeDb((scopedTx: typeof tx) => scopedTx.insert(itemsTable).values(item)),
    );
  }
};

export const promiseAllMapFanOut = async () => {
  await Promise.all(
    items.map(async (item) => {
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: intentionally unbatched to exercise the rule
      await tx.select().from(itemsTable).where(item.id);
    }),
  );
};

// A `.map()` callback passed by name (not inline) still fans out one DB
// call per item; the rule resolves `indexRow` to its local `const`
// definition in the same lexical scope. The flag lands on the outer
// `Promise.all(...)` await, not the inner one inside `indexRow` -- the
// inner await is never itself lexically inside a loop or an inline
// `.map()` callback, so it is not independently flagged.
export const promiseAllMapNamedCallback = async () => {
  const indexRow = async (item: { id: string }): Promise<number> => {
    await tx.insert(itemsTable).values(item);
    return 1;
  };
  // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: named callback resolved to its local definition to exercise the rule
  await Promise.all(items.map(indexRow));
};

// A `.map()` callback that returns a DB call without `await`ing it still
// issues one query per item once `Promise.all` awaits the whole array.
export const promiseAllMapAwaitlessFanOut = async () => {
  // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, typescript/promise-function-async -- fixture: bare (non-awaited) DB call returned from the `.map()` callback to exercise the rule; `async` would only trip require-await since there is nothing to await
  await Promise.all(items.map((item) => tx.insert(itemsTable).values(item)));
};

// `Promise.allSettled` fans out exactly like `Promise.all`.
export const promiseAllSettledMapFanOut = async () => {
  await Promise.allSettled(
    items.map(async (item) => {
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: intentionally unbatched to exercise Promise.allSettled detection
      await tx.select().from(itemsTable).where(item.id);
    }),
  );
};

export const resultAwaitPromiseAllMapFanOut = async function* () {
  // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: safe handlers may delegate a Promise.all fan-out through Result.await
  yield* Result.await(
    Promise.all(
      items.map((item) =>
        safeDb((scopedTx: typeof tx) =>
          scopedTx.insert(itemsTable).values(item),
        ),
      ),
    ),
  );
};

// --- Cases the rule MUST NOT flag ---

// A single DB await outside any loop.
export const singleAwaitOutsideLoop = async () => {
  await db.select().from(itemsTable).where(items[0]?.id);
};

export const singleResultAwaitOutsideLoop = async function* () {
  yield* Result.await(
    safeDb((scopedTx: typeof tx) =>
      scopedTx.select().from(itemsTable).where(items[0]?.id),
    ),
  );
};

// Batched: one query for the whole loop's ids, built with `inArray` after
// an in-memory (non-awaiting) loop. The DB await itself is not inside a
// loop.
export const batchedWithInArray = async () => {
  const ids: string[] = [];
  for (const item of items) {
    ids.push(item.id);
  }
  await db.select().from(itemsTable).where(inArray(idColumn, ids));
};

// A loop over a fixed, tiny, compile-time-constant array is bounded
// regardless of tenant data size, so the query count cannot scale with
// input — suppressed with a documented reason.
export const boundedConstantLoop = async () => {
  const fixedStatuses = ["draft", "final"] as const;
  for (const status of fixedStatuses) {
    // SAFETY: fixedStatuses is a 2-element compile-time constant, not
    // tenant-scaled input, so this cannot become an N+1.
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop
    await tx.select().from(itemsTable).where(status);
  }
};

// A loop with no DB await at all is never in scope.
export const inMemoryLoop = () => {
  for (const item of items) {
    doInMemoryWork(item);
  }
};

// A DB await inside a nested function declared inside a loop, but not
// itself a `.map`/`.forEach`/`.flatMap` callback fanned out via
// `Promise.all` — the rule stops at the function boundary. (The call site
// of `fetcher`, if awaited in a loop, would be flagged there instead.)
export const makeFetcherPerIteration = () => {
  for (const item of items) {
    const fetcher = async () => {
      await tx.select().from(itemsTable).where(item.id);
    };
    void fetcher;
  }
};

// A named `.map()` callback resolved to its local definition, but that
// definition has no DB call inside it at all -- in-memory work only.
export const promiseAllMapNamedCallbackNoDbCall = async () => {
  const summarize = async (item: { id: string }): Promise<string> => {
    await doInMemoryWorkAsync(item);
    return item.id;
  };
  await Promise.all(items.map(summarize));
};

// A `.map()` callback with no DB call -- an ordinary in-memory transform
// fanned out through Promise.all.
export const promiseAllMapAwaitlessNoDbCall = async () => {
  await Promise.all(
    items.map(async (item) => {
      await doInMemoryWorkAsync(item);
      return item.id;
    }),
  );
};

// `Promise.allSettled` fan-out with no DB call inside the callback.
export const promiseAllSettledMapNoDbCall = async () => {
  await Promise.allSettled(
    items.map(async (item) => {
      await doInMemoryWorkAsync(item);
      return item.id;
    }),
  );
};
