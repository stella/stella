import { AsyncLocalStorage } from "node:async_hooks";

/** Response header carrying the per-request correlation id (receipt). */
export const REQUEST_ID_HEADER = "x-request-id";

type RequestContext = {
  startTime: number;
  requestId: string;
  posthogDistinctId?: string;
  organizationId?: string;
  sessionId?: string;
};

const requestContextStore = new WeakMap<Request, RequestContext>();

/**
 * Ambient current-request id. Activated per request via `enterWith` (the same
 * mechanism the DB query counter uses), so code that has no `Request` in hand —
 * the MCP tool-error envelope, the generic-invoke success payload — can still
 * stamp the receipt without threading the id through every call. The lookup is a
 * no-op when no request is active (background jobs, boot-time work, tests that
 * never open a request scope), so those paths simply carry no receipt.
 */
const requestIdStore = new AsyncLocalStorage<string>();

/**
 * A per-request correlation id: `req_` + 128 bits of Bun-native randomness
 * (time-ordered UUIDv7, dashes stripped) as 32 hex chars. Opaque and
 * unguessable; surfaced in the `x-request-id` response header, the MCP error
 * envelope, and generic-invoke success payloads so an operator can tie a
 * client-visible receipt back to server logs.
 */
const generateRequestId = (): string =>
  `req_${Bun.randomUUIDv7().replaceAll("-", "")}`;

export const initRequestContext = (
  request: Request,
  sessionId?: string,
): void => {
  const requestId = generateRequestId();
  const context: RequestContext = {
    startTime: performance.now(),
    requestId,
  };

  if (sessionId) {
    context.sessionId = sessionId;
  }

  requestContextStore.set(request, context);
  // Bind the id to this request's async context so ambient readers
  // (`getCurrentRequestId`) resolve it without a `Request` handle. Each request
  // enters its own async context before `onRequest` runs, so the store does not
  // leak across concurrent requests (same guarantee as
  // `beginRequestQueryCounter`).
  requestIdStore.enterWith(requestId);
};

export const enrichRequestContext = (
  request: Request,
  update: Partial<Omit<RequestContext, "startTime" | "requestId">>,
): void => {
  const current = requestContextStore.get(request);
  if (!current) {
    return;
  }

  Object.assign(current, update);
};

export const getRequestContext = (
  request: Request,
): RequestContext | undefined => requestContextStore.get(request);

/** The receipt id bound to `request`, or `undefined` if it was never scoped. */
export const getRequestId = (request: Request): string | undefined =>
  requestContextStore.get(request)?.requestId;

/** The receipt id of the active request async context, if any. */
export const getCurrentRequestId = (): string | undefined =>
  requestIdStore.getStore();

/**
 * Run `fn` with `requestId` bound as the ambient current-request id. Used by
 * tests (and any programmatic caller outside the HTTP layer) to exercise the
 * receipt-stamping paths that read {@link getCurrentRequestId}.
 */
export const runWithRequestId = <TResult>(
  requestId: string,
  fn: () => TResult,
): TResult => requestIdStore.run(requestId, fn);
