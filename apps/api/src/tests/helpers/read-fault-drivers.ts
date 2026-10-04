/**
 * Fault drivers for publisher reads.
 *
 * A driver builds a decision from an enrolled fixture twice: once as served,
 * and once with every request of one fetch stage failing in one way (a 500, a
 * timeout, an empty 204, an empty 200 body). A faulted build must fail (throw,
 * or end in a typed non-built result the fixture refuses), build exactly the
 * decision the control did, or state the failure typed:
 * - a part withheld: a `StoredReadUnavailable` of scope "part" on a decision
 *   whose main text (fulltext, AST, sections) is exactly the control's. A part
 *   marker never excuses a failed main text: that must fail the item.
 * - the document withheld: a `StoredReadUnavailable` of scope "document" on a
 *   decision held listing-only (`isListingOnly`, or the "listing-only"
 *   observation detail), so a stored row is not overwritten.
 * A failed read stored as an absence is degraded: faults are never absences.
 * A build that succeeds with different content otherwise turned a failed read
 * into missing or empty fields. Some adapters must fail on every fault (the
 * pipeline, not the adapter, marks an item after repeated failures); for
 * them only a failure or the control decision passes.
 *
 * A refusal (401, 403) is a separate class with a stricter expectation: the
 * build must state it as a typed refusal, either a typed refused marker on the
 * decision (`ReadRefusal`; or the pipeline's "secondary-refused" observation
 * detail, or a scope "part" refusal, for a withheld part, again only with the
 * main text intact) or a typed refused failure (a source-level
 * `publisher_refusal` stop, or an error carrying a `ReadRefusal`). Failing
 * untyped, or building unchanged, does not state it.
 *
 * Fixtures replace `globalThis.fetch` inside their build, so the driver keeps
 * the interception in an accessor that wraps whatever the fixture installs.
 */

import { panic, Result } from "better-result";

import { INGESTION_STOP_KIND } from "@stll/legal-atlas/ingestion-cycle";

import {
  isReadRefusal,
  isStoredReadAbsence,
  isStoredReadUnavailable,
} from "@/api/lib/errors/read-outcome";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { OBSERVATION_DETAIL } from "@/api/lib/legal-search/partial-observation-sql";
import { isRecord } from "@/api/lib/type-guards";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

export const READ_FAULTS = [
  "status-500",
  "timeout",
  "no-content-204",
  "empty-body-200",
] as const;

export type ReadFault = (typeof READ_FAULTS)[number];

export const READ_REFUSALS = ["refused-401", "refused-403"] as const;

export type ReadRefusalFault = (typeof READ_REFUSALS)[number];

const REFUSAL_STATUS = {
  "refused-401": 401,
  "refused-403": 403,
} as const satisfies Record<ReadRefusalFault, number>;

export type FaultOutcome =
  | { readonly type: "surfaced" }
  | { readonly type: "recovered" }
  | { readonly type: "degraded"; readonly changed: readonly string[] };

/** What a build did with a refused read: stated it typed, or not. */
export type RefusalOutcome =
  | { readonly type: "surfaced" }
  | {
      readonly type: "untyped";
      readonly how: "failed" | "unchanged" | "changed" | "main-text-failed";
      readonly changed: readonly string[];
    };

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
const fetchStageOf = (input: FetchInput, init?: RequestInit): string => {
  const request = input instanceof Request ? input : null;
  const url = new URL(hrefOf(input));
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const path = url.pathname.replaceAll(UUID, "{id}").replaceAll(/\d+/gu, "{n}");
  return `${method} ${url.host}${path}`;
};

/** The answer a faulted request receives in place of the served one. */
export const faultedResponse = async (
  fault: ReadFault | ReadRefusalFault,
  served: Delegate,
): Promise<Response> => {
  switch (fault) {
    case "refused-401":
    case "refused-403":
      return new Response("", { status: REFUSAL_STATUS[fault] });
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
const withInterceptedFetch = async <T>(
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
  fault: ReadFault | ReadRefusalFault;
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

/** The decision's main text: its failure fails the item, never a part. */
const MAIN_TEXT = /^(?:fulltext|documentAst|sections)(?:$|[.[])/u;

type MarkerCount = { part: number; document: number; absent: number };

/**
 * Count the typed outcome markers a built value carries. With a refusal
 * status, refusals of that status (and the "secondary-refused" detail) count;
 * without one, stored unavailable markers count.
 */
const countMarkers = (
  value: unknown,
  refusalStatus: number | null,
  into: MarkerCount,
): MarkerCount => {
  if (value instanceof Map) {
    return countMarkers(Object.fromEntries(value), refusalStatus, into);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      countMarkers(item, refusalStatus, into);
    }
    return into;
  }
  if (!isRecord(value) || value instanceof Uint8Array) {
    return into;
  }
  if (isReadRefusal(value)) {
    if (value.status === refusalStatus) {
      into[value.scope === "part" ? "part" : "document"] += 1;
    }
    return into;
  }
  if (isStoredReadUnavailable(value)) {
    if (refusalStatus === null) {
      into[value.scope] += 1;
    }
    return into;
  }
  if (isStoredReadAbsence(value)) {
    into.absent += 1;
    return into;
  }
  if (
    refusalStatus !== null &&
    value["observationDetail"] === OBSERVATION_DETAIL.SECONDARY_REFUSED
  ) {
    into.part += 1;
  }
  for (const item of Object.values(value)) {
    countMarkers(item, refusalStatus, into);
  }
  return into;
};

/** Markers the faulted build carries beyond the control's. */
const addedMarkers = (
  control: unknown,
  faulted: unknown,
  refusalStatus: number | null,
): MarkerCount => {
  const before = countMarkers(control, refusalStatus, {
    part: 0,
    document: 0,
    absent: 0,
  });
  const after = countMarkers(faulted, refusalStatus, {
    part: 0,
    document: 0,
    absent: 0,
  });
  return {
    part: after.part - before.part,
    document: after.document - before.document,
    absent: after.absent - before.absent,
  };
};

const isListingOnly = (value: unknown): boolean =>
  isRecord(value) &&
  (value["isListingOnly"] === true ||
    value["observationDetail"] === OBSERVATION_DETAIL.LISTING_ONLY);

const changedBetween = (
  control: unknown,
  faulted: unknown,
  volatile: ReadonlySet<string>,
): string[] =>
  changedPaths(flattenBuilt(control), flattenBuilt(faulted)).filter(
    (path) => !volatile.has(path),
  );

/**
 * What a faulted build did with the failure. `volatile` names paths that
 * differ between two unfaulted builds (timestamps), which say nothing about
 * the fault. `requireFailure` admits only a failure or the control decision.
 */
export const classifyFaultedBuild = ({
  control,
  faulted,
  volatile,
  requireFailure = false,
}: {
  control: unknown;
  faulted: Result<unknown, unknown>;
  volatile: ReadonlySet<string>;
  requireFailure?: boolean;
}): FaultOutcome => {
  if (Result.isError(faulted)) {
    return { type: "surfaced" };
  }
  const changed = changedBetween(control, faulted.value, volatile);
  if (changed.length === 0) {
    return { type: "recovered" };
  }
  if (requireFailure) {
    return { type: "degraded", changed };
  }
  const added = addedMarkers(control, faulted.value, null);
  if (added.absent > 0) {
    return { type: "degraded", changed };
  }
  if (added.part > 0 && !changed.some((path) => MAIN_TEXT.test(path))) {
    return { type: "surfaced" };
  }
  if (added.document > 0 && isListingOnly(faulted.value)) {
    return { type: "surfaced" };
  }
  return { type: "degraded", changed };
};

/** A failure that states a refusal: a source-level stop or a carried marker. */
const isTypedRefusalFailure = (error: unknown): boolean =>
  (error instanceof AdapterFetchError &&
    error.stopKind === INGESTION_STOP_KIND.PUBLISHER_REFUSAL) ||
  isReadRefusal(error) ||
  (error instanceof Error && isReadRefusal(error.cause));

/**
 * What a build with one stage refused did with the refusal. Only a typed
 * refusal surfaces it; an untyped failure, an unchanged build and a part
 * refusal hiding a failed main text do not.
 */
export const classifyRefusedBuild = ({
  control,
  faulted,
  fault,
  volatile,
}: {
  control: unknown;
  faulted: Result<unknown, unknown>;
  fault: ReadRefusalFault;
  volatile: ReadonlySet<string>;
}): RefusalOutcome => {
  if (Result.isError(faulted)) {
    return isTypedRefusalFailure(faulted.error)
      ? { type: "surfaced" }
      : { type: "untyped", how: "failed", changed: [] };
  }
  const changed = changedBetween(control, faulted.value, volatile);
  const added = addedMarkers(control, faulted.value, REFUSAL_STATUS[fault]);
  if (added.document > 0) {
    return { type: "surfaced" };
  }
  if (added.part > 0) {
    return changed.some((path) => MAIN_TEXT.test(path))
      ? { type: "untyped", how: "main-text-failed", changed }
      : { type: "surfaced" };
  }
  return changed.length === 0
    ? { type: "untyped", how: "unchanged", changed }
    : { type: "untyped", how: "changed", changed };
};
