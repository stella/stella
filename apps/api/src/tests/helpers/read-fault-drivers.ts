/**
 * Fault drivers for publisher reads.
 *
 * A driver builds a decision from an enrolled fixture twice: once as served,
 * and once with every request of one fetch stage failing in one way (a 500, a
 * timeout, an empty 204, an empty 200 body). A faulted build must either fail
 * (throw, or end in a typed non-built result the fixture refuses) or build
 * exactly the decision the control did. A build that succeeds with different
 * content turned a failed read into missing or empty fields.
 *
 * Fixtures replace `globalThis.fetch` inside their build, so the driver keeps
 * the interception in an accessor that wraps whatever the fixture installs.
 */

import { panic, Result } from "better-result";

import { isRecord } from "@/api/lib/type-guards";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

export const READ_FAULTS = [
  "status-500",
  "timeout",
  "no-content-204",
  "empty-body-200",
] as const;

export type ReadFault = (typeof READ_FAULTS)[number];

export type FaultOutcome =
  | { readonly type: "surfaced" }
  | { readonly type: "recovered" }
  | { readonly type: "degraded"; readonly changed: readonly string[] };

type FetchInput = string | URL | Request;
type Delegate = () => Promise<Response>;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

const hrefOf = (input: FetchInput): string => {
  if (input instanceof Request) {
    return input.url;
  }
  return input instanceof URL ? input.href : input;
};

/**
 * A request's fetch stage: method, host and path with identifiers folded, so
 * the same read of another document is the same stage.
 */
export const fetchStageOf = (input: FetchInput, init?: RequestInit): string => {
  const request = input instanceof Request ? input : null;
  const url = new URL(hrefOf(input));
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const path = url.pathname.replaceAll(UUID, "{id}").replaceAll(/\d+/gu, "{n}");
  return `${method} ${url.host}${path}`;
};

/** The answer a faulted request receives in place of the served one. */
export const faultedResponse = async (
  fault: ReadFault,
  served: Delegate,
): Promise<Response> => {
  switch (fault) {
    case "status-500":
      return new Response("", { status: 500 });
    case "timeout":
      return await Promise.reject(
        new DOMException("The operation timed out.", "TimeoutError"),
      );
    case "no-content-204":
      return new Response(null, { status: 204 });
    case "empty-body-200": {
      const response = await served();
      await response.body?.cancel();
      return new Response("", { status: 200, headers: response.headers });
    }
    default:
      fault satisfies never;
      return panic(`Unknown fault: ${String(fault)}`);
  }
};

/**
 * Run `build` with every fetch it (or a fixture inside it) installs routed
 * through `intercept`, then restore the global.
 */
export const withInterceptedFetch = async <T>(
  intercept: (stage: string, served: Delegate) => Promise<Response>,
  build: () => Promise<T>,
): Promise<T> => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  let inner = globalThis.fetch;
  const wrapper = asFetchMock(
    async (input: FetchInput, init?: RequestInit) =>
      await intercept(
        fetchStageOf(input, init),
        async () => await inner(input, init),
      ),
  );
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    get: () => wrapper,
    set: (value: typeof fetch) => {
      inner = value;
    },
  });
  try {
    return await build();
  } finally {
    if (descriptor !== undefined) {
      Object.defineProperty(globalThis, "fetch", descriptor);
    }
    globalThis.fetch = inner;
  }
};

/** The stages a build reads, in first-request order. */
export const recordFetchStages = async <T>(
  build: () => Promise<T>,
): Promise<{ value: T; stages: readonly string[] }> => {
  const stages: string[] = [];
  const value = await withInterceptedFetch(async (stage, served) => {
    if (!stages.includes(stage)) {
      stages.push(stage);
    }
    return await served();
  }, build);
  return { value, stages };
};

/** Build with every request of `stage` failing as `fault`. */
export const buildWithFault = async <T>({
  stage,
  fault,
  build,
}: {
  stage: string;
  fault: ReadFault;
  build: () => Promise<T>;
}): Promise<Result<T, unknown>> =>
  await Result.tryPromise({
    try: async () =>
      await withInterceptedFetch(
        async (requested, served) =>
          requested === stage
            ? await faultedResponse(fault, served)
            : await served(),
        build,
      ),
    catch: (error) => error,
  });

const leafText = (value: unknown): string => {
  if (value instanceof Uint8Array) {
    return `bytes:${Buffer.from(value).toString("base64")}`;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
};

/** Every leaf of a built value by its path, for a field-level comparison. */
export const flattenBuilt = (
  value: unknown,
  path = "",
  into = new Map<string, string>(),
): Map<string, string> => {
  if (value instanceof Map) {
    return flattenBuilt(Object.fromEntries(value), path, into);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      into.set(path, "[]");
    }
    for (const [index, item] of value.entries()) {
      flattenBuilt(item, `${path}[${String(index)}]`, into);
    }
    return into;
  }
  if (isRecord(value) && !(value instanceof Uint8Array)) {
    const entries = Object.entries(value).filter(
      ([, item]) => item !== undefined,
    );
    if (entries.length === 0) {
      into.set(path, "{}");
    }
    for (const [key, item] of entries) {
      flattenBuilt(item, path === "" ? key : `${path}.${key}`, into);
    }
    return into;
  }
  into.set(path, leafText(value));
  return into;
};

/** Paths whose leaves differ between two flattened builds. */
export const changedPaths = (
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): string[] =>
  [...new Set([...left.keys(), ...right.keys()])]
    .filter((path) => left.get(path) !== right.get(path))
    .toSorted();

/**
 * What a faulted build did with the failure. `volatile` names paths that
 * differ between two unfaulted builds (timestamps), which say nothing about
 * the fault.
 */
export const classifyFaultedBuild = ({
  control,
  faulted,
  volatile,
}: {
  control: unknown;
  faulted: Result<unknown, unknown>;
  volatile: ReadonlySet<string>;
}): FaultOutcome => {
  if (Result.isError(faulted)) {
    return { type: "surfaced" };
  }
  const changed = changedPaths(
    flattenBuilt(control),
    flattenBuilt(faulted.value),
  ).filter((path) => !volatile.has(path));
  return changed.length === 0
    ? { type: "recovered" }
    : { type: "degraded", changed };
};
