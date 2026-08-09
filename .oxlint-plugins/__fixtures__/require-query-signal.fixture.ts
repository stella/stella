// Passive regression fixture for `require-query-signal/require-query-signal`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The
// clean calls at the end carry no disable, so the rule over-firing on them
// also fails CI.

import * as api from "node:http";

import { queryOptions as importedQueryFn } from "@tanstack/react-query";

import { api as edenApi } from "@/lib/api";

declare const url: string;
declare const workspaceId: string;
declare const request: { signal: AbortSignal };

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
    const response = await edenApi.tasks.get();
    return response.data;
  },
};

export const wrongDestructureOptions = {
  queryKey: ["things", "paged"],
  queryFn: async ({ pageParam: _pageParam }: { pageParam: number }) =>
    // oxlint-disable-next-line require-query-signal/require-query-signal
    await edenApi.tasks.get(),
};

export const nestedMemberChainOptions = {
  queryKey: ["workspace-reports", workspaceId],
  queryFn: async () => {
    // oxlint-disable-next-line require-query-signal/require-query-signal
    const response = await edenApi
      .workspaces({ workspaceId })
      .overview.activity.get();
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

export const globalThisFetchOptions = {
  queryKey: ["thing", "global-this-fetch"],
  queryFn: async () =>
    // oxlint-disable-next-line require-query-signal/require-query-signal -- fixture: the genuine globalThis fetch root must retain detection
    await globalThis.fetch(url),
};

export const signalOnlyReachesFirstCallOptions = {
  queryKey: ["thing", "two-requests"],
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    await fetch(url, { signal });
    // oxlint-disable-next-line require-query-signal/require-query-signal
    return await edenApi.tasks.get();
  },
};

export const assertedApiWithoutSignalOptions = {
  queryKey: ["things", "asserted"],
  queryFn: async ({ signal: _signal }: { signal: AbortSignal }) =>
    // oxlint-disable-next-line require-query-signal/require-query-signal, typescript/no-unnecessary-type-assertion -- Exercise TS-wrapper traversal while preserving the missing-signal finding.
    await (edenApi as typeof edenApi).tasks.get(),
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

// Same-file function declarations used as queryFn values are inspected.
async function declaredFetchQueryFn() {
  // oxlint-disable-next-line require-query-signal/require-query-signal -- fixture: same-file declaration drops the query signal
  return await fetch(url);
}

export const declaredFetchReferenceOptions = {
  queryKey: ["thing", "declared-helper"],
  queryFn: declaredFetchQueryFn,
};

// Const arrow initializers are inspected too, including direct Eden calls.
const constEdenQueryFn = async () =>
  // oxlint-disable-next-line require-query-signal/require-query-signal -- fixture: const arrow drops the query signal
  await edenApi.tasks.get();

export const constEdenReferenceOptions = {
  queryKey: ["things", "const-helper"],
  queryFn: constEdenQueryFn,
};

const selfFetchQueryFn = async () =>
  // oxlint-disable-next-line require-query-signal/require-query-signal -- fixture: the genuine self fetch root remains a direct network call
  await self.fetch(url);

export const selfFetchReferenceOptions = {
  queryKey: ["thing", "self-fetch-helper"],
  queryFn: selfFetchQueryFn,
};

// Destructuring signal is insufficient when the direct call receives another
// signal instead.
async function declaredWrongSignalQueryFn({
  signal: _signal,
}: {
  signal: AbortSignal;
}) {
  // oxlint-disable-next-line require-query-signal/require-query-signal -- fixture: the TanStack signal is present but not threaded
  return await fetch(url, { signal: request.signal });
}

export const declaredWrongSignalReferenceOptions = {
  queryKey: ["thing", "declared-wrong-signal"],
  queryFn: declaredWrongSignalQueryFn,
};

// Stable const aliases and TS wrappers preserve same-file provenance.
const aliasedMissingSignalTarget = async () =>
  // oxlint-disable-next-line require-query-signal/require-query-signal -- fixture: aliases cannot hide a direct network call
  await edenApi.tasks.get();
const firstMissingSignalAlias = aliasedMissingSignalTarget;
const secondMissingSignalAlias =
  firstMissingSignalAlias satisfies typeof firstMissingSignalAlias;

export const aliasedMissingSignalReferenceOptions = {
  queryKey: ["things", "aliased-helper"],
  queryFn: secondMissingSignalAlias,
};

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
    await edenApi.tasks.get({ fetch: { signal } }),
};

export const signalInSecondEdenArgumentOptions = {
  queryKey: ["things", "post", "safe"],
  queryFn: async ({ signal }: { signal: AbortSignal }) =>
    await edenApi.tasks.post({ value: "ok" }, { fetch: { signal } }),
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
    const response = await edenApi.tasks.get({ fetch: { signal } });
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

// A stable same-file identifier is inspected and stays valid when it threads
// the query signal.
export const helperReferenceOptions = {
  queryKey: ["thing", "helper"],
  queryFn: fetchThing,
};

async function declaredSafeEdenQueryFn({
  signal,
}: {
  signal: AbortSignal;
}) {
  return await edenApi.tasks.get({ fetch: { signal } });
}

export const declaredSafeEdenReferenceOptions = {
  queryKey: ["things", "declared-safe-helper"],
  queryFn: declaredSafeEdenQueryFn,
};

const safeAliasedTarget = async ({ signal }: { signal: AbortSignal }) =>
  await fetch(url, { signal });
const safeAliasedQueryFn = safeAliasedTarget;

export const safeAliasedReferenceOptions = {
  queryKey: ["thing", "safe-aliased-helper"],
  queryFn: safeAliasedQueryFn satisfies typeof safeAliasedQueryFn,
};

// Imports are cross-file and deliberately opaque.
export const importedReferenceOptions = {
  queryKey: ["thing", "imported-helper"],
  queryFn: importedQueryFn,
};

// Inline browser-global lookalikes are unrelated local bindings.
export const makeInlineLocalFetchOptions = (
  fetch: (input: string) => Promise<unknown>,
) => ({
  queryKey: ["thing", "inline-local-fetch"],
  queryFn: async () => await fetch(url),
});

export const makeInlineLocalWindowOptions = (window: {
  fetch: (input: string) => Promise<unknown>;
}) => ({
  queryKey: ["thing", "inline-local-window-fetch"],
  queryFn: async () => await window.fetch(url),
});

export const makeInlineLocalApiOptions = (
  // oxlint-disable-next-line eslint/no-shadow -- fixture: local API-shaped parameters must not inherit Eden import provenance
  api: { things: { get: () => Promise<unknown> } },
) => ({
  queryKey: ["thing", "inline-local-api"],
  queryFn: async () => await api.things.get(),
});

// An unrelated imported namespace named api is not the Eden client.
export const inlineUnrelatedImportedApiOptions = {
  queryKey: ["thing", "inline-imported-api"],
  queryFn: () => api.get(url),
};

// Identifier-valued queryFns retain the binding identities of local fetch,
// browser-host, and API-shaped parameters.
const localFetchQueryFn = async (
  fetch: (input: string) => Promise<unknown>,
) => await fetch(url);
export const localFetchReferenceOptions = {
  queryKey: ["thing", "local-fetch-helper"],
  queryFn: localFetchQueryFn,
};

const localSelfFetchQueryFn = async (self: {
  fetch: (input: string) => Promise<unknown>;
}) => await self.fetch(url);
export const localSelfFetchReferenceOptions = {
  queryKey: ["thing", "local-self-fetch-helper"],
  queryFn: localSelfFetchQueryFn,
};

const localApiQueryFn = async (
  // oxlint-disable-next-line eslint/no-shadow -- fixture: identifier queryFns retain their local API parameter binding
  api: { things: { get: () => Promise<unknown> } },
) => await api.things.get();
export const localApiReferenceOptions = {
  queryKey: ["thing", "local-api-helper"],
  queryFn: localApiQueryFn,
};

const importedApiQueryFn = () => api.get(url);
export const unrelatedImportedApiReferenceOptions = {
  queryKey: ["thing", "imported-api-helper"],
  queryFn: importedApiQueryFn,
};

// Mutable and reassigned bindings are deliberately opaque, even if one
// possible initializer contains a direct network call.
let mutableQueryFn = async () => await fetch(url);
export const replaceMutableQueryFn = (
  replacement: () => Promise<Response>,
) => {
  mutableQueryFn = replacement;
};

export const mutableReferenceOptions = {
  queryKey: ["thing", "mutable-helper"],
  queryFn: mutableQueryFn,
};

// Overload sets have ambiguous definitions and remain unproven.
function overloadedQueryFn(context: {
  kind: "basic";
  signal: AbortSignal;
}): Promise<Response>;
// oxlint-disable-next-line typescript/unified-signatures -- fixture: overload definitions make the queryFn binding deliberately ambiguous
function overloadedQueryFn(context: {
  kind: "paged";
  pageParam: number;
  signal: AbortSignal;
}): Promise<Response>;
async function overloadedQueryFn(
  _context:
    | { kind: "basic"; signal: AbortSignal }
    | { kind: "paged"; pageParam: number; signal: AbortSignal },
) {
  return await fetch(url);
}

export const overloadedReferenceOptions = {
  queryKey: ["thing", "overloaded-helper"],
  queryFn: overloadedQueryFn,
};

// Binding identity prevents a same-named inner declaration from attributing
// its queryFn use to this unrelated outer function.
export async function shadowedQueryFn() {
  return await fetch(url);
}

export const makeShadowedReferenceOptions = () => {
  // oxlint-disable-next-line eslint/no-shadow -- fixture: binding identity must select this inner helper
  const shadowedQueryFn = async ({ signal }: { signal: AbortSignal }) =>
    await fetch(url, { signal });
  return {
    queryKey: ["thing", "shadowed-helper"],
    queryFn: shadowedQueryFn,
  };
};

// A parameter shadow is opaque and must not resolve to this same-named outer
// declaration.
export async function parameterShadowTarget() {
  return await fetch(url);
}

export const makeParameterShadowReferenceOptions = (
  // oxlint-disable-next-line eslint/no-shadow -- fixture: parameter binding must not resolve to the outer declaration
  parameterShadowTarget: () => Promise<Response>,
) => ({
  queryKey: ["thing", "parameter-shadow-helper"],
  queryFn: parameterShadowTarget,
});

// Call results are not stable bindings and remain opaque.
const createOpaqueQueryFn = () => async () => await fetch(url);
export const callResultReferenceOptions = {
  queryKey: ["thing", "call-result-helper"],
  queryFn: createOpaqueQueryFn(),
};

// Same-file resolution is intentionally one function deep: a queryFn that
// calls another helper does not make that nested helper its owned body.
const nestedNetworkHelper = async () => await fetch(url);
const transitiveQueryFn = async () => await nestedNetworkHelper();
export const transitiveReferenceOptions = {
  queryKey: ["thing", "transitive-helper"],
  queryFn: transitiveQueryFn,
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
