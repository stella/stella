// Failure vocabulary and classification, shared by every runtime that throws
// or observes a failure.

import { Result } from "better-result";
//
// A failure is observed with a finite `reason`; its grade is a function of
// that reason, read from one policy map, so a credentials rejection can never
// be recorded as a cancellation and free text can never reach the grade.

export const FAILURE_GRADES = [
  "anticipated",
  "transient",
  "client",
  "defect",
] as const;

export type FailureGrade = (typeof FAILURE_GRADES)[number];

export const FAILURE_REASON_GRADE = {
  upstream_unavailable: "transient",
  provider_unavailable: "transient",
  // The provider's stream stopped before its answer finished: a dropped
  // connection or a provider-side cut, not a fault of this service.
  provider_stream_incomplete: "transient",
  quota_exhausted: "transient",
  pg_connection_lifecycle: "transient",
  // 40001: the designed outcome of a serializable or repeatable-read
  // transaction; the retry is the caller's.
  pg_serialization_failure: "transient",
  // Only through a boundary declaration: the owner that set the budget knows
  // the lock or statement timeout is expected.
  pg_lock_timeout_budgeted: "transient",
  pg_statement_budget_exhausted: "transient",
  redis_connection: "transient",
  redis_poll_blip: "transient",
  network_reset: "transient",
  network_timeout: "transient",
  dns_unavailable: "transient",
  // Only through a declaration at a fetch boundary with a validated
  // destination; a refused connection alone cannot tell an outage from a
  // wrong address.
  upstream_connection_refused: "transient",
  generation_cancelled: "anticipated",
  chat_loop_detected: "anticipated",
  chat_empty_completion: "anticipated",
  provider_billing: "anticipated",
  provider_credentials_rejected: "anticipated",
  model_unavailable: "anticipated",
  credentials_token_unreadable: "anticipated",
  client_disconnected: "anticipated",
  optional_file_absent: "anticipated",
  request_invalid: "client",
  access_denied: "client",
  usage_limited: "client",
  not_found: "client",
  conflict: "client",
  rate_limited: "client",
  precondition_required: "client",
  request_validation: "client",
  route_not_found: "client",
  request_malformed: "client",
  unclassified: "defect",
  unobserved_5xx: "defect",
  rls_denied: "defect",
  response_invalid: "defect",
  // 40P01 reaches a sink only after the transaction retry gave up, so what is
  // left is a lock-order signal rather than contention.
  pg_deadlock: "defect",
  pg_lock_unavailable: "defect",
  pg_query_canceled: "defect",
  pg_auth_failed: "defect",
  connection_refused: "defect",
  socket_open_failed: "defect",
  timeout_unbounded: "defect",
  invalid_declaration: "defect",
} as const satisfies Record<string, FailureGrade>;

export type FailureReason = keyof typeof FAILURE_REASON_GRADE;

/**
 * Reasons an administrator has to act on. Named once so routing them to an
 * admin keys on this list rather than on call sites. `anticipated` does not
 * mean "needs no attention": these keep their existing admin-facing answers.
 */
export const MISCONFIGURATION_REASONS = [
  "provider_billing",
  "provider_credentials_rejected",
  "model_unavailable",
  "credentials_token_unreadable",
  "pg_auth_failed",
] as const satisfies readonly FailureReason[];

export const isFailureReason = (value: unknown): value is FailureReason =>
  typeof value === "string" && Object.hasOwn(FAILURE_REASON_GRADE, value);

export const failureGradeOf = (reason: FailureReason): FailureGrade =>
  FAILURE_REASON_GRADE[reason];

// --- Classification brand ---------------------------------------------------
//
// Provenance, not a field. Only the two functions below can attach a
// classification, and both keep it in module-private weak maps: no string
// property on a foreign error is ever read as one, and JSON cannot create a
// map entry, so an SDK that copies remote fields onto an Error cannot spoof
// it.

const INVALID_DECLARATION = "invalid_declaration" satisfies FailureReason;

// Deep enough for any real class hierarchy; bounded because a Proxy can
// answer `getPrototypeOf` with an endless chain.
const MAX_PROTOTYPE_DEPTH = 16;

type ClassDeclaration = (instance: object) => FailureReason;

const instanceReasons = new WeakMap<object, FailureReason>();
const classDeclarations = new WeakMap<object, ClassDeclaration>();

const validReason = (reason: unknown): FailureReason =>
  isFailureReason(reason) ? reason : INVALID_DECLARATION;

/**
 * Classify one error instance. For a boundary that has already decided what
 * a failure is, such as the AI error mapper naming a provider rejection before
 * it wraps it. Returns the error so the call can sit inside a constructor
 * expression.
 */
export const classifyFailure = <TError extends object>(
  error: TError,
  reason: FailureReason,
): TError => {
  instanceReasons.set(error, validReason(reason));
  return error;
};

type ErrorClass<TInstance extends object> = abstract new (
  ...args: never
) => TInstance;

/**
 * Classify every instance of a class, statically or from the instance. Matched
 * by prototype identity, so a subclass inherits the declaration and a foreign
 * class with the same name does not.
 */
export const declareFailureClass = <TInstance extends object>(
  errorClass: ErrorClass<TInstance>,
  declaration: FailureReason | ((instance: TInstance) => FailureReason),
): void => {
  const prototype: unknown = errorClass.prototype;
  if (typeof prototype !== "object" || prototype === null) {
    return;
  }
  if (typeof declaration !== "function") {
    const reason = validReason(declaration);
    classDeclarations.set(prototype, () => reason);
    return;
  }
  classDeclarations.set(prototype, (instance) =>
    instance instanceof errorClass
      ? validReason(declaration(instance))
      : INVALID_DECLARATION,
  );
};

export type FailureBrand = {
  readonly reason: FailureReason;
  readonly source: "class" | "instance";
};

const prototypeOf = (value: object): unknown =>
  Result.try((): unknown => Object.getPrototypeOf(value)).unwrapOr(undefined);

const prototypeChain = (value: object): object[] => {
  const chain: object[] = [];
  let prototype = prototypeOf(value);
  while (
    typeof prototype === "object" &&
    prototype !== null &&
    chain.length < MAX_PROTOTYPE_DEPTH
  ) {
    chain.push(prototype);
    prototype = prototypeOf(prototype);
  }
  return chain;
};

const resolveDeclaration = (
  declaration: ClassDeclaration,
  instance: object,
): FailureReason =>
  Result.try(() => declaration(instance)).unwrapOr(INVALID_DECLARATION);

/**
 * The classification attached to `value`, if any. Never throws: a revoked
 * Proxy or a throwing declaration reads as no brand or as
 * `invalid_declaration`, never as an exception at a failure sink.
 *
 * A reader that has already walked the prototype chain passes it, so a Proxy
 * whose `getPrototypeOf` answers differently on each call is read once.
 */
export const readFailureBrand = (
  value: unknown,
  prototypes?: readonly object[],
): FailureBrand | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const own = instanceReasons.get(value);
  if (own !== undefined) {
    return { reason: own, source: "instance" };
  }
  for (const prototype of prototypes ?? prototypeChain(value)) {
    const declaration = classDeclarations.get(prototype);
    if (declaration !== undefined) {
      return {
        reason: resolveDeclaration(declaration, value),
        source: "class",
      };
    }
  }
  return undefined;
};
