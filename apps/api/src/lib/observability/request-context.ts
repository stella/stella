import { AsyncLocalStorage } from "node:async_hooks";

/** Response header carrying the per-request correlation id (receipt). */
export const REQUEST_ID_HEADER = "x-request-id";

type RequestContext = {
  startTime: number;
  requestId: string;
  clientIp?: string | null;
  signupRateLimitIp?: string | null;
  posthogDistinctId?: string;
  organizationId?: string;
  sessionId?: string;
};

const requestContextStore = new WeakMap<Request, RequestContext>();

/**
 * Ambient current-request id, so code that has no `Request` in hand — the MCP
 * tool-error envelope, the generic-invoke success payload — can still stamp the
 * receipt without threading the id through every call. The lookup is a no-op
 * when no request is active (background jobs, boot-time work, tests that never
 * open a request scope), so those paths simply carry no receipt.
 *
 * The store holds a mutable slot rather than the id itself because the scope is
 * opened at the fetch boundary (see `server.ts`) while the id is generated
 * later, in {@link initRequestContext}. That split is deliberate:
 * `AsyncLocalStorage.enterWith` would let the hook open the scope itself, but it
 * mutates the ambient async context frame with no restore point, so a
 * background timer or worker loop resuming while a request's frame is current
 * adopts that request's id and stamps it on unrelated work from then on. `run`
 * at the boundary confines the scope to the request's own callback tree.
 */
type AmbientRequestId = { current: string | null };

const requestIdStore = new AsyncLocalStorage<AmbientRequestId>();

/**
 * Open an empty request-id scope for `fn` and its continuations. The HTTP layer
 * calls this around the composed request handler; {@link initRequestContext}
 * fills in the id once it has generated one.
 */
export const runWithRequestIdScope = <TResult>(fn: () => TResult): TResult =>
  requestIdStore.run({ current: null }, fn);

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
  // Bind the id to the scope the fetch boundary opened for this request, so
  // ambient readers (`getCurrentRequestId`) resolve it without a `Request`
  // handle. Callers outside the HTTP layer (tests, programmatic entry points)
  // open no scope and simply carry no ambient id.
  const ambient = requestIdStore.getStore();
  if (ambient) {
    ambient.current = requestId;
  }
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
  requestIdStore.getStore()?.current ?? undefined;

/**
 * Run `fn` with `requestId` bound as the ambient current-request id. Used by
 * tests (and any programmatic caller outside the HTTP layer) to exercise the
 * receipt-stamping paths that read {@link getCurrentRequestId}.
 */
export const runWithRequestId = <TResult>(
  requestId: string,
  fn: () => TResult,
): TResult => requestIdStore.run({ current: requestId }, fn);
