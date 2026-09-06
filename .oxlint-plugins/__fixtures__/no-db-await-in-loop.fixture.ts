// Passive regression fixture for `no-db-await-in-loop/no-db-await-in-loop`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag (a DB call awaited inside a loop body through native `await`
// or `yield* Result.await(...)`, a helper awaited in a loop with a database
// handle in its arguments, or a fan-out via `Promise.all(items.map(...))` /
// `Promise.allSettled(items.map(...))`, inline or via a named callback
// resolved to its local definition, awaited or not). If the rule regresses,
// the matching disable goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. The cases
// WITHOUT a `no-db-await-in-loop` disable must NOT be flagged by it; a false
// positive there fails the same run.

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
  tryPromise: <T>(
    source: (() => Promise<T>) | { try: () => Promise<T>; catch: unknown },
  ) => Promise<T>;
};
declare const rootDb: {
  query: { items: { findFirst: (args: unknown) => Promise<unknown> } };
};
declare const ctx: { tx: typeof tx };
declare const tables: Record<string, unknown>;
declare const items: { id: string }[];
declare const groups: { items: { id: string }[] }[];
declare const itemPages: AsyncIterable<{ id: string }>;
// Per-row helpers: the query lives behind the call, so only the handle in the
// argument list marks them as database work.
declare function upsertRow(
  handle: unknown,
  item: { id: string },
): Promise<void>;
declare function persistRow(args: {
  db?: unknown;
  tx?: unknown;
  id: string;
}): Promise<void>;
declare function computeRow(item: { id: string }): Promise<string>;
declare function enqueue(task: () => Promise<void>): Promise<void>;
declare const itemsTable: unknown;
declare const idColumn: unknown;
declare const inArray: (col: unknown, values: unknown[]) => unknown;
declare function doInMemoryWork(item: unknown): void;
declare function doInMemoryWorkAsync(item: unknown): Promise<void>;

// --- Cases the rule MUST flag ---

export const forOfLoopAwaitInsert = async () => {
  for (const item of items) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: intentionally unbatched to exercise the rule
    await tx.insert(itemsTable).values(item);
  }
};

export const whileLoopAwaitSafeDb = async () => {
  let index = 0;
  const results: unknown[] = [];
  while (index < items.length) {
    const currentItem = items[index];
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: intentionally unbatched to exercise the rule
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
      safeDb(async (scopedTx: typeof tx) => {
        const inserted = await scopedTx.insert(itemsTable).values(item);
        return inserted;
      }),
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
      items.map(
        // oxlint-disable-next-line typescript/promise-function-async -- fixture: the awaitless callback proves Result.await fan-out detection does not depend on an inner AwaitExpression
        (item) =>
          safeDb(async (scopedTx: typeof tx) => {
            const result = await scopedTx.insert(itemsTable).values(item);
            return result;
          }),
      ),
    ),
  );
};

// A helper hides the query, but the handle is right there in the argument
// list: one round-trip per row all the same.
export const forOfLoopHelperPositionalHandle = async () => {
  for (const item of items) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: per-row helper call to exercise positional handle detection
    await upsertRow(tx, item);
  }
};

// The handle arrives as an object-literal property value under a handle key.
export const forOfLoopHelperObjectProperty = async () => {
  for (const item of items) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: per-row helper call to exercise object-property handle detection
    await persistRow({ db: rootDb, id: item.id });
  }
};

// Shorthand is the same property, spelled once.
export const whileLoopHelperShorthandHandle = async () => {
  let index = 0;
  while (index < items.length) {
    const id = items[index]?.id ?? "";
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: per-row helper call to exercise shorthand handle detection
    await persistRow({ tx, id });
    index += 1;
  }
};

// The handle reached through the request context is still the handle.
export const forOfLoopHelperMemberHandle = async () => {
  for (const item of items) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: per-row helper call to exercise member-access handle detection
    await upsertRow(ctx.tx, item);
  }
};

// The inner loop is the one that scales; the outer one multiplies it.
export const nestedLoopHelperHandle = async () => {
  for (const group of groups) {
    for (const item of group.items) {
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: nested loop over a per-row helper call
      await upsertRow(tx, item);
    }
  }
};

// `for await` iterates a stream, and its body re-runs per item like any other.
export const forAwaitLoopHelperHandle = async () => {
  for await (const item of itemPages) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: for-await body running a per-row helper call
    await upsertRow(tx, item);
  }
};

// A `yield* Result.await(...)` of a per-row helper is the same call in safe
// handler dress.
export const forOfLoopResultAwaitHelperHandle = async function* () {
  for (const item of items) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: delegated Result.await of a per-row helper call
    yield* Result.await(upsertRow(tx, item));
  }
};

// A fan-out whose callback awaits a same-file helper holding the handle is
// reported once, on the `Promise.all(...)` the fan-out check owns. The inner
// `await persistRow(...)` carries no directive: a second report there would
// fail this fixture as an unsuppressed error.
export const promiseAllMapHelperHandleReportedOnce = async () => {
  const storeRow = async (item: { id: string }): Promise<void> => {
    await tx.insert(itemsTable).values(item);
  };
  // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: the fan-out check owns this report; the handle shape must not add a second
  await Promise.all(
    items.map(async (item) => {
      await storeRow(item);
      await persistRow({ tx, id: item.id });
    }),
  );
};

// The callback returns a per-row helper carrying the handle and never awaits
// it, so no inner `AwaitExpression` exists for the walk-up path to find: the
// fan-out scan is the only thing that can see this shape.
export const promiseAllMapHelperHandleAwaitless = async () => {
  // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, typescript/promise-function-async -- fixture: awaitless per-row helper carrying the handle; `async` would only trip require-await
  await Promise.all(items.map((item) => upsertRow(tx, item)));
};

// The same fan-out nested in a loop: still one report, on the fan-out.
export const loopedPromiseAllMapHelperHandle = async () => {
  for (const group of groups) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, typescript/promise-function-async -- fixture: per-loop fan-out over a per-row helper carrying the handle
    await Promise.all(group.items.map((item) => upsertRow(tx, item)));
  }
};

// `Promise.allSettled` fans out the helper shape exactly like `Promise.all`.
export const promiseAllSettledMapHelperHandle = async () => {
  // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: awaitless per-row helper carrying the handle under allSettled
  await Promise.allSettled(
    // oxlint-disable-next-line typescript/promise-function-async -- fixture: `async` would only trip require-await
    items.map((item) => persistRow({ tx, id: item.id })),
  );
};

// --- Cases the rule MUST NOT flag ---

// A single DB await outside any loop.
export const singleAwaitOutsideLoop = async () => {
  await db.select().from(itemsTable).where(items[0]?.id);
};

export const singleResultAwaitOutsideLoop = async function* () {
  yield* Result.await(
    safeDb(async (scopedTx: typeof tx) => {
      const selected = await scopedTx
        .select()
        .from(itemsTable)
        .where(items[0]?.id);
      return selected;
    }),
  );
};

// A `while` test re-runs every iteration, so a query there is as
// per-iteration as one in the body.
export const whileTestQuery = async () => {
  let remaining = 0;
  // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: the loop test runs one query per iteration
  while ((await tx.select().from(itemsTable).where(remaining)) !== null) {
    remaining += 1;
  }
};

// `Result.tryPromise` runs its callback where it stands, so the query inside
// it belongs to the loop rather than to a deferred call site.
export const resultTryPromiseInLoop = async () => {
  for (const item of items) {
    await Result.tryPromise({
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: the tryPromise callback is part of the loop body
      try: async () => await tx.insert(itemsTable).values(item),
      catch: (cause: unknown) => cause,
    });
  }
};

// A table reached through computed access still resolves to the `tx` root.
export const computedTableQuery = async () => {
  for (const item of items) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- fixture: computed access resolves to the DB root
    await tx.insert(tables["case-law"]).values(item);
  }
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
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop
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

// The same helper awaited once, outside any loop: one round-trip.
export const helperHandleOutsideLoop = async () => {
  await upsertRow(tx, { id: items[0]?.id ?? "" });
};

// The handle sits inside an arrow passed as a callback, so the awaited call
// enqueues work rather than running a query per iteration. The inner await is
// behind a function boundary the rule stops at, and the outer `enqueue(...)`
// receives a function, not a handle.
export const loopEnqueuesHandleCallback = async () => {
  for (const item of items) {
    await enqueue(async () => {
      await upsertRow(tx, item);
    });
  }
};

// A helper awaited per iteration that takes no handle at all is in-memory
// work as far as this rule can tell.
export const loopHelperWithoutHandle = async () => {
  for (const item of items) {
    await computeRow(item);
  }
};

// A fan-out whose callback calls a helper with no database handle is an
// ordinary parallel transform.
export const promiseAllMapHelperWithoutHandle = async () => {
  await Promise.all(items.map(async (item) => await computeRow(item)));
};

// The same per-row helper, mapped but never awaited as a fan-out: `.map()`
// alone starts nothing this rule is about.
export const mapHelperHandleWithoutFanOut = () => {
  // oxlint-disable-next-line typescript/promise-function-async -- fixture: the callback must stay awaitless so the mapped array is the only product
  const pending = items.map((item) => upsertRow(tx, item));
  return pending.length;
};

// A literal array is fixed at author time, so it is bounded by construction.
export const promiseAllLiteralArrayHelperHandle = async () => {
  const first = items[0] ?? { id: "" };
  await Promise.all([upsertRow(tx, first), upsertRow(ctx.tx, first)]);
};
