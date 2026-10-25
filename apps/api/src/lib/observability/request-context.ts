import { AsyncLocalStorage } from "node:async_hooks";

import type { FailureGrade, FailureReason } from "@stll/errors";

import type { ClientAddress, ClientAddressSource } from "@/api/lib/client-ip";

type RequestContext = {
  startTime: number;
  requestId: string;
  clientIp?: string | null;
  clientAddressSource?: ClientAddressSource | null;
  signupRateLimitIp?: string | null;
  posthogDistinctId?: string;
  organizationId?: string;
  sessionId?: string;
  failureObservation?: RequestFailureObservation;
  /** Whether the request's one log record and duration metric were written. */
  recorded?: boolean;
};

/**
 * The failure a request observed on its way to an answer, so the completion
 * record grades the answer by what failed rather than by its status class.
 */
type RequestFailureObservation = {
  readonly grade: FailureGrade;
  readonly reason: FailureReason;
  readonly sink: string;
};

/**
 * Everything the server knows about the request in flight, held in the async
 * scope the HTTP layer opens around it (see `runWithRequestScope`). Code that
 * runs for the request reads it without a `Request` handle, and a stage that
 * passes inner stages a derived request (a size-bounded copy) keeps it.
 *
 * The scope is opened with `run` at the fetch boundary, never `enterWith`:
 * `enterWith` mutates the ambient async context frame with no restore point,
 * so a background timer or worker loop resuming while a request's frame is
 * current would adopt that request from then on. `run` confines the scope to
 * the request's own callback tree.
 */
type AmbientRequestState = {
  context: RequestContext | undefined;
  mountedRoute?: string;
  /**
   * Whether this request committed to synchronous AI inference. Read at
   * request completion to tag the latency metric `class=ai`, so inherently
   * multi-second model calls stay out of the CRUD p95 SLO. Set from the
   * model-resolution seam, so the dynamic AI paths (usage preflight deep
   * inside fill/suggest helpers, MCP tools) need no extra threading.
   */
  isAiRequest: boolean;
  /**
   * The address the request arrived from, resolved once while its edge
   * headers were still present. A stage that hands inner stages a derived
   * request keeps it, because it lives in the scope, not on the request.
   */
  clientAddress?: ClientAddress | null;
};

const requestStore = new AsyncLocalStorage<AmbientRequestState>();

/**
 * Open an empty request scope for `fn` and its continuations. The HTTP layer
 * calls this around the whole pipeline; {@link openRequestContext} fills it
 * in once the request's id exists.
 */
export const runWithRequestIdScope = <TResult>(fn: () => TResult): TResult =>
  requestStore.run({ context: undefined, isAiRequest: false }, fn);

/**
 * Tag the active request as AI-classed for the split latency SLO. Called
 * from the model-resolution seam (`resolveTanStackTextModel`), which every
 * inference path passes through, so classification cannot be forgotten at
 * a call site. No-op outside a request scope (background workers), whose
 * durations never reach the completion record.
 */
export const markAiRequest = (): void => {
  const ambient = requestStore.getStore();
  if (ambient) {
    ambient.isAiRequest = true;
  }
};

/** Whether the active request was tagged AI-classed; `false` outside a scope. */
export const isAiRequest = (): boolean =>
  requestStore.getStore()?.isAiRequest ?? false;

/** The outer endpoint owns the route even when nested auth calls share its scope.
 * Only registered templates belong here; never a request pathname. */
export const markMountedRequestRoute = (template: string): void => {
  const ambient = requestStore.getStore();
  if (ambient) {
    ambient.mountedRoute ??= template;
  }
};

export const getMountedRequestRoute = (): string | undefined =>
  requestStore.getStore()?.mountedRoute;

/** Record the request's client address for every later reader in its scope. */
export const sealRequestClientAddress = (
  clientAddress: ClientAddress | null,
): void => {
  const ambient = requestStore.getStore();
  if (ambient) {
    ambient.clientAddress = clientAddress;
  }
};

/** The sealed client address; `undefined` outside a request or before sealing. */
export const sealedRequestClientAddress = ():
  ClientAddress | null | undefined => requestStore.getStore()?.clientAddress;

/**
 * A per-request correlation id: `req_` + 128 bits of Bun-native randomness
 * (time-ordered UUIDv7, dashes stripped) as 32 hex chars. Opaque and
 * unguessable; surfaced in the `x-request-id` response header, the MCP error
 * envelope, and generic-invoke success payloads so an operator can tie a
 * client-visible receipt back to server logs.
 */
const generateRequestId = (): string =>
  `req_${Bun.randomUUIDv7().replaceAll("-", "")}`;

/**
 * Start the active request's context with a fresh id. No-op outside a request
 * scope: programmatic callers that open none carry no context.
 */
export const openRequestContext = (sessionId?: string): void => {
  const ambient = requestStore.getStore();
  if (!ambient) {
    return;
  }
  ambient.context = {
    startTime: performance.now(),
    requestId: generateRequestId(),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
};

export const enrichRequestContext = (
  update: Partial<
    Omit<
      RequestContext,
      "failureObservation" | "recorded" | "requestId" | "startTime"
    >
  >,
): void => {
  const current = requestStore.getStore()?.context;
  if (current) {
    Object.assign(current, update);
  }
};

/**
 * Record the failure the active request observed. The last observation wins:
 * the one nearest the answer (the request pipeline's own) is the one the
 * answer was chosen from.
 */
export const recordRequestFailure = (
  observation: RequestFailureObservation,
): void => {
  const current = requestStore.getStore()?.context;
  if (current) {
    current.failureObservation = observation;
  }
};

/**
 * Claim the active request's log record. True for the first caller only, so a
 * request answered by the error boundary is not recorded again on completion.
 */
export const claimRequestRecord = (): boolean => {
  const current = requestStore.getStore()?.context;
  if (current === undefined || current.recorded === true) {
    return false;
  }
  current.recorded = true;
  return true;
};

export const getRequestFailure = (): RequestFailureObservation | undefined =>
  requestStore.getStore()?.context?.failureObservation;

export const getRequestContext = (): RequestContext | undefined =>
  requestStore.getStore()?.context;

/** The receipt id of the active request, if one is open. */
export const getRequestId = (): string | undefined =>
  requestStore.getStore()?.context?.requestId;

/**
 * Run `fn` inside a request scope carrying `requestId`. Used by tests (and any
 * programmatic caller outside the HTTP layer) to exercise the receipt-stamping
 * paths that read {@link getRequestId}.
 */
export const runWithRequestId = <TResult>(
  requestId: string,
  fn: () => TResult,
): TResult =>
  requestStore.run(
    {
      context: { startTime: performance.now(), requestId },
      isAiRequest: false,
    },
    fn,
  );
