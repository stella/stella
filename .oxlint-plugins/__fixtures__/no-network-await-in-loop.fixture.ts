// Passive regression fixture for
// `no-network-await-in-loop/no-network-await-in-loop`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag (a network call awaited inside a loop body, through a
// fetch-owning module, a global `fetch`, an AWS SDK command dispatch, an
// Eden client method, or a delegated `Result.await(...)`). If the rule
// regresses, the matching disable goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. The cases
// WITHOUT a disable must NOT be flagged; a false positive there fails the
// same run.

import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
// A local helper whose name merely looks like a fetch wrapper: the rule
// matches import sources, not spellings.
import { fetchLocalCache } from "unrelated-cache";

import { fetchWithTimeout } from "@stll/fetch";

import { fetchWithTimeout as aliasedFetch } from "@/api/lib/fetch";
import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";
import { api } from "@/lib/api";

declare const ids: string[];
declare const urls: string[];
declare const Result: {
  await: <T>(promise: Promise<T>) => AsyncGenerator<never, T, unknown>;
  tryPromise: <T>(
    source: (() => Promise<T>) | { try: () => Promise<T>; catch: unknown },
  ) => Promise<T>;
};
declare const stream: AsyncIterable<Uint8Array>;
declare function consume(chunk: Uint8Array): void;
declare function collect(value: unknown): void;

// --- Cases the rule MUST flag ---

export const globalFetchInForOf = async () => {
  for (const url of urls) {
    // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- fixture: intentionally sequential to exercise the rule
    const response = await fetch(url);
    collect(response.status);
  }
};

export const fetchWrapperInWhile = async () => {
  let index = 0;
  while (index < urls.length) {
    // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- fixture: intentionally sequential to exercise the rule
    collect(await fetchWithTimeout(urls[index] ?? "", { timeoutMs: 5000 }));
    index += 1;
  }
};

export const aliasedFetchWrapperInDoWhile = async () => {
  let remaining = ids.length;
  do {
    // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- fixture: an aliased import of the same owner is still a network call
    collect(await aliasedFetch("https://example.test/items", { timeoutMs: 1 }));
    remaining -= 1;
  } while (remaining > 0);
};

export const safeOutboundFetchInForOf = async () => {
  for (const url of urls) {
    // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- fixture: every binding of a fetch-owning module counts
    collect(await safeOutboundFetchBytes({ url, maxBytes: 1, timeoutMs: 1 }));
  }
};

export const awsCommandSendInForOf = async (s3: S3Client) => {
  for (const key of ids) {
    // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- fixture: AWS SDK command dispatch per iteration
    collect(await s3.send(new GetObjectCommand({ Bucket: "b", Key: key })));
  }
};

export const edenClientInForOf = async () => {
  for (const id of ids) {
    // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- fixture: a method on the Eden client is a round-trip
    collect(await api.documents({ id }).get());
  }
};

export const resultAwaitFetchInForOf = async function* () {
  for (const url of urls) {
    // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- fixture: the Result boundary spelling of the same await
    yield* Result.await(fetchWithTimeout(url, { timeoutMs: 5000 }));
  }
};

// A loop that carries state between iterations is a real exception, not an
// oversight: it is accepted only through this directive and its reason.
export const paginatedCursorWalk = async () => {
  let cursor: string | null = "";
  while (cursor !== null) {
    // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- the next request needs this response's cursor, so the walk cannot fan out
    const page: { nextCursor: string | null } = await api.documents.list.get({
      query: { cursor },
    });
    cursor = page.nextCursor;
  }
};

// A `while` test re-runs on every iteration, so an await there is as
// per-iteration as one in the body.
export const awaitInWhileTest = async () => {
  let attempts = 0;
  // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- fixture: the probe in the loop test runs once per iteration
  while (!(await fetch("/ready")).ok && attempts < 5) {
    attempts += 1;
  }
};

export const awaitInForUpdate = async () => {
  for (
    let page = 0;
    page < 5;
    // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- fixture: the update expression runs once per iteration
    page = (await fetch(`/pages/${String(page)}`)).status
  ) {
    collect(page);
  }
};

// `Result.tryPromise` runs its callback where it stands: the await inside it
// is the loop's own work, in both the bare and the object form.
export const resultTryPromiseInForOf = async () => {
  for (const url of urls) {
    // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- fixture: the tryPromise callback is part of the loop body
    collect(await Result.tryPromise(async () => await fetch(url)));
  }
};

export const resultTryPromiseObjectFormInForOf = async () => {
  for (const url of urls) {
    collect(
      await Result.tryPromise({
        // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- fixture: the object form's `try` callback is part of the loop body
        try: async () => await fetchWithTimeout(url, { timeoutMs: 5000 }),
        catch: (cause: unknown) => cause,
      }),
    );
  }
};

// A generated route name that is not a valid identifier is reached through
// computed access; its root is still the imported client.
export const computedEdenRouteInForOf = async () => {
  for (const id of ids) {
    // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- fixture: computed access resolves to the imported client root
    collect(await api.workspaces["copy-to-workspace"].post({ id }));
  }
};

// --- Cases the rule must NOT flag ---

// The bounded fan-out this rule asks for.
export const batchedFanOut = async () => {
  const responses = await Promise.all(
    // oxlint-disable-next-line typescript/promise-function-async -- fixture: the point is the un-awaited call the fan-out collects; `async` would only trip require-await
    urls.map((url) => fetch(url)),
  );
  collect(responses.length);
};

// `for await` over a stream: the iteration's implicit await is not an
// `AwaitExpression`, and a stream has no fan-out to batch.
export const streamConsumption = async () => {
  for await (const chunk of stream) {
    consume(chunk);
  }
};

// A network call awaited inside a nested function belongs to that function's
// own call site, not to the loop that merely defines it.
export const definedNotAwaited = () => {
  const loaders: (() => Promise<unknown>)[] = [];
  for (const url of urls) {
    loaders.push(async () => await fetch(url));
  }
  return loaders;
};

// A `for-of` right-hand side and a `for` initializer are evaluated once, not
// once per iteration.
export const awaitInLoopHead = async () => {
  for (const url of (await fetch("/list")).headers.keys()) {
    collect(url);
  }
};

export const awaitInForInitializer = async () => {
  for (let page = (await fetch("/pages/first")).status; page < 5; page += 1) {
    collect(page);
  }
};

// Not a network call: same-shaped name, different owner.
export const localHelperInForOf = async () => {
  for (const id of ids) {
    collect(await fetchLocalCache(id));
  }
};

// `send` without an AWS SDK command argument is out of scope.
export const transportSendInForOf = async (transport: {
  send: (message: string) => Promise<void>;
}) => {
  for (const id of ids) {
    await transport.send(id);
  }
};

// No loop at all.
export const singleFetch = async () => await fetch(urls[0] ?? "");
