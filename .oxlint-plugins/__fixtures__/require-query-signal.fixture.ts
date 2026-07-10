// Passive regression fixture for `require-query-signal/require-query-signal`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The
// clean calls at the end carry no disable, so the rule over-firing on them
// also fails CI.

declare const url: string;
declare const workspaceId: string;
declare const request: { signal: AbortSignal };

const api = {
  things: {
    get: async (_opts?: { fetch?: { signal?: AbortSignal } }) => {
      await Promise.resolve();
      return { data: null as unknown, error: null as unknown };
    },
    post: async (
      _body: { value: string },
      _opts?: { fetch?: { signal?: AbortSignal } },
    ) => {
      await Promise.resolve();
      return { data: null as unknown, error: null as unknown };
    },
  },
  workspaces: (_params: { workspaceId: string }) => ({
    reports: {
      get: async (_opts?: { fetch?: { signal?: AbortSignal } }) => {
        await Promise.resolve();
        return { data: null as unknown, error: null as unknown };
      },
    },
  }),
};

const loadFromWorker = async () => {
  await Promise.resolve();
  return "ok";
};

const fetchThing = async ({ signal }: { signal: AbortSignal }) =>
  await fetch(url, { signal });

// --- Cases the rule MUST flag ---

export const noParamsFetchOptions = {
  queryKey: ["thing"],
  queryFn: async () => {
    // oxlint-disable-next-line require-query-signal/require-query-signal
    const response = await fetch(url);
    return await response.json();
  },
};

export const noParamsEdenOptions = {
  queryKey: ["things"],
  queryFn: async () => {
    // oxlint-disable-next-line require-query-signal/require-query-signal
    const response = await api.things.get();
    return response.data;
  },
};

export const wrongDestructureOptions = {
  queryKey: ["things", "paged"],
  queryFn: async ({ pageParam: _pageParam }: { pageParam: number }) =>
    // oxlint-disable-next-line require-query-signal/require-query-signal
    await api.things.get(),
};

export const nestedMemberChainOptions = {
  queryKey: ["workspace-reports", workspaceId],
  queryFn: async () => {
    // oxlint-disable-next-line require-query-signal/require-query-signal
    const response = await api.workspaces({ workspaceId }).reports.get();
    return response.data;
  },
};

export const directCallInsideIfOptions = {
  queryKey: ["thing", "conditional"],
  queryFn: async () => {
    if (workspaceId) {
      // oxlint-disable-next-line require-query-signal/require-query-signal
      return await fetch(url);
    }
    return null;
  },
};

export const signalOnlyReachesFirstCallOptions = {
  queryKey: ["thing", "two-requests"],
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    await fetch(url, { signal });
    // oxlint-disable-next-line require-query-signal/require-query-signal
    return await api.things.get();
  },
};

export const assertedApiWithoutSignalOptions = {
  queryKey: ["things", "asserted"],
  queryFn: async ({ signal: _signal }: { signal: AbortSignal }) =>
    // oxlint-disable-next-line require-query-signal/require-query-signal, typescript/no-unnecessary-type-assertion -- Exercise TS-wrapper traversal while preserving the missing-signal finding.
    await (api as typeof api).things.get(),
};

export const unrelatedSignalPropertyOptions = {
  queryKey: ["thing", "unrelated-signal"],
  queryFn: async ({ signal: _signal }: { signal: AbortSignal }) =>
    // oxlint-disable-next-line require-query-signal/require-query-signal
    await fetch(url, { signal: request.signal }),
};

// Factory functions that return a query-options object are still in scope.
export const thingOptions = () => ({
  queryKey: ["thing", "factory"],
  // oxlint-disable-next-line require-query-signal/require-query-signal
  queryFn: async () => await fetch(url),
});

// --- Cases the rule MUST NOT flag ---

export const signalDestructuredFetchOptions = {
  queryKey: ["thing", "safe"],
  queryFn: async ({ signal }: { signal: AbortSignal }) =>
    await fetch(url, { signal }),
};

export const aliasedSignalOptions = {
  queryKey: ["thing", "aliased-signal"],
  queryFn: async ({ signal: querySignal }: { signal: AbortSignal }) =>
    await fetch(url, { signal: querySignal }),
};

export const signalDestructuredEdenOptions = {
  queryKey: ["things", "safe"],
  queryFn: async ({ signal }: { signal: AbortSignal }) =>
    await api.things.get({ fetch: { signal } }),
};

export const signalInSecondEdenArgumentOptions = {
  queryKey: ["things", "post", "safe"],
  queryFn: async ({ signal }: { signal: AbortSignal }) =>
    await api.things.post({ value: "ok" }, { fetch: { signal } }),
};

export const signalAlongsideOtherParamsOptions = {
  queryKey: ["things", "paged", "safe"],
  queryFn: async ({
    signal,
    pageParam,
  }: {
    signal: AbortSignal;
    pageParam: number;
  }) => {
    const response = await api.things.get({ fetch: { signal } });
    return { ...response, pageParam };
  },
};

export const composedSignalOptions = {
  queryKey: ["thing", "timeout"],
  queryFn: async ({ signal }: { signal: AbortSignal }) =>
    await window.fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
    }),
};

// Identifier reference — the rule does not follow into helper functions.
export const helperReferenceOptions = {
  queryKey: ["thing", "helper"],
  queryFn: fetchThing,
};

// No direct fetch/api call in the body.
export const noNetworkCallOptions = {
  queryKey: ["thing", "worker"],
  queryFn: async () => await loadFromWorker(),
};

// A network call nested inside a closure defined within the queryFn is a
// separate function boundary and is not attributed to the outer queryFn,
// even though the outer queryFn itself has no `signal` param either.
export const nestedClosureOptions = {
  queryKey: ["thing", "nested-closure"],
  queryFn: async () => {
    const run = async () => await fetch(url);
    return await run().then((response) => response.headers.get("etag"));
  },
};

// No sibling `queryKey` — not a recognized query-options object.
export const notAQueryOptionsObject = {
  queryFn: async () => await fetch(url),
};
