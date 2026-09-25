/**
 * How a failure is graded and which of its fields may leave the process.
 *
 * Every sink reads one evidence snapshot (`failure-evidence.ts`) and grades it
 * here, by one ordered rule list, into a finite reason whose grade comes from
 * the shared policy map in `@stll/errors`. The closed code sets live here too,
 * and the pg and Redis predicates read them from here, so a transient code
 * added for one reader is added for all of them.
 *
 * The grade is observation only: retry, park and exit decisions keep their own
 * predicates.
 *
 * Env-free: the runner and the pg predicates import it.
 */

import { Panic, panic } from "better-result";

import type { FailureGrade, FailureReason } from "@stll/errors";
import { failureGradeOf } from "@stll/errors";

import {
  MAX_TRANSPORT_WRAPPER_DEPTH,
  TRANSPORT_WRAPPERS,
} from "@/api/lib/errors/handler-error-resolution";
import type { HandlerErrorStatusCode } from "@/api/lib/errors/tagged-errors";
import type {
  EvidenceNode,
  FailureEvidence,
  FrameEvidence,
} from "@/api/lib/observability/failure-evidence";
import {
  PG_IDENTIFIER_PROPERTIES,
  readEvidence,
} from "@/api/lib/observability/failure-evidence";

// --- Closed code sets ---------------------------------------------------------

/**
 * Bun driver codes for a connection that is gone, as opposed to a query the
 * server rejected. The driver reports this category in `code`; a SQLSTATE,
 * when there is one, lives in `errno`, so these never collide with the
 * SQLSTATE table below.
 *
 * Retirement by the pool's own `idleTimeout` and `maxLifetime` bounds belongs
 * with the server-side closures: Bun retires a connection when the timer
 * expires whether or not a caller still holds it, so the interrupted work is
 * neither lost nor invalid, and the next attempt gets a fresh connection.
 *
 * `CONNECTION_FAILED` is the same story at the other end of the connection's
 * life: the driver documents it as accepted but closed before the handshake
 * completed, which is what a server that is still starting up looks like.
 * Which of these a given failure surfaces as is not stable across driver
 * versions, so callers must treat the set as one condition rather than
 * branching on a member.
 *
 * `ERR_POSTGRES_CONNECTION_REFUSED` is deliberately absent: the driver
 * documents it as nothing listening at the address, fails it immediately, and
 * does not retry. Treating it as transient would turn a wrong host or port
 * into a silent retry loop rather than a failure someone reads.
 */
export const PG_DRIVER_ERROR = {
  CONNECTION_CLOSED: "ERR_POSTGRES_CONNECTION_CLOSED",
  CONNECTION_FAILED: "ERR_POSTGRES_CONNECTION_FAILED",
  CONNECTION_TIMEOUT: "ERR_POSTGRES_CONNECTION_TIMEOUT",
  IDLE_TIMEOUT: "ERR_POSTGRES_IDLE_TIMEOUT",
  LIFETIME_TIMEOUT: "ERR_POSTGRES_LIFETIME_TIMEOUT",
} as const;

type PgDriverCode = (typeof PG_DRIVER_ERROR)[keyof typeof PG_DRIVER_ERROR];

export const PG_DRIVER_CODE_REASON = {
  ERR_POSTGRES_CONNECTION_CLOSED: "pg_connection_lifecycle",
  ERR_POSTGRES_CONNECTION_FAILED: "pg_connection_lifecycle",
  ERR_POSTGRES_CONNECTION_TIMEOUT: "pg_connection_lifecycle",
  ERR_POSTGRES_IDLE_TIMEOUT: "pg_connection_lifecycle",
  ERR_POSTGRES_LIFETIME_TIMEOUT: "pg_connection_lifecycle",
} as const satisfies Record<PgDriverCode, FailureReason>;

/**
 * SQLSTATEs Postgres answers with when the backend can speak the protocol but
 * will not serve the connection: it is still starting up or in recovery
 * (`57P03`), an operator shut it down (`57P01`), it is tearing down after
 * another backend crashed (`57P02`), or an idle-session timeout retired it
 * (`57P05`). The same conditions as the driver codes above, seen from the
 * other side of a completed handshake, so neither set covers the condition
 * without the other.
 *
 * `57014` (`query_canceled`) and `57P04` (`database_dropped`) share the class
 * and are deliberately absent: neither is repaired by retrying the same work
 * against a fresh connection.
 */
export const PG_CONNECTION_LIFECYCLE_SQL_STATES = [
  "57P01",
  "57P02",
  "57P03",
  "57P05",
] as const;

type PgLifecycleSqlState = (typeof PG_CONNECTION_LIFECYCLE_SQL_STATES)[number];

export const PG_SQL_STATE_REASON = {
  "57P01": "pg_connection_lifecycle",
  "57P02": "pg_connection_lifecycle",
  "57P03": "pg_connection_lifecycle",
  "57P05": "pg_connection_lifecycle",
  "40001": "pg_serialization_failure",
  "40P01": "pg_deadlock",
  "55P03": "pg_lock_unavailable",
  "57014": "pg_query_canceled",
  "28P01": "pg_auth_failed",
  "28000": "pg_auth_failed",
} as const satisfies Record<PgLifecycleSqlState, FailureReason> &
  Record<string, FailureReason>;

/**
 * Valkey codes a periodic loop meets while the connection is down and comes
 * back: a command that finds the socket closed, or one still waiting on a
 * connect attempt. `redis-client.ts` reconnects without an attempt cap, which
 * is what makes them transient; `ERR_REDIS_IDLE_TIMEOUT` is absent because
 * Bun does not reconnect after one.
 */
export const REDIS_CONNECTION_ERROR_CODES = [
  "ERR_REDIS_CONNECTION_CLOSED",
  "ERR_REDIS_CONNECTION_TIMEOUT",
] as const;

/**
 * Bun's BullMQ Redis adapter intermittently fails to parse a reply on a
 * worker's idle blocking poll. Self-recovering: the worker keeps draining.
 */
export const REDIS_POLL_BLIP_ERROR_CODE = "ERR_REDIS_INVALID_RESPONSE";

export const REDIS_ERROR_CODE_REASON = {
  ERR_REDIS_CONNECTION_CLOSED: "redis_connection",
  ERR_REDIS_CONNECTION_TIMEOUT: "redis_connection",
  ERR_REDIS_INVALID_RESPONSE: "redis_poll_blip",
} as const satisfies Record<
  | (typeof REDIS_CONNECTION_ERROR_CODES)[number]
  | typeof REDIS_POLL_BLIP_ERROR_CODE,
  FailureReason
>;

/**
 * Socket and DNS codes from Node, Bun and undici. A refused connection, a
 * socket that never opened and an unbounded timeout stay defects: none of
 * them tells an outage from a wrong address or a missing deadline, so only a
 * boundary that knows its destination may declare otherwise.
 */
export const NETWORK_ERROR_CODE_REASON = {
  ECONNRESET: "network_reset",
  EPIPE: "network_reset",
  ConnectionClosed: "network_reset",
  UND_ERR_SOCKET: "network_reset",
  ETIMEDOUT: "network_timeout",
  UND_ERR_CONNECT_TIMEOUT: "network_timeout",
  EAI_AGAIN: "dns_unavailable",
  ECONNREFUSED: "connection_refused",
  FailedToOpenSocket: "socket_open_failed",
} as const satisfies Record<string, FailureReason>;

const TIMEOUT_CLASS_NAME = "TimeoutError";

/**
 * `HandlerError` codes that carry a grade. Closed, so a misspelt code fails to
 * compile at the constructor rather than silently grading as a defect.
 */
const GRADED_HANDLER_CODES = ["upstream_unavailable"] as const;

type GradedHandlerCode = (typeof GRADED_HANDLER_CODES)[number];

const GRADED_HANDLER_CODE_REASON = {
  upstream_unavailable: "upstream_unavailable",
} as const satisfies Record<GradedHandlerCode, FailureReason>;

type HandlerClientStatus = Exclude<HandlerErrorStatusCode, 500 | 502 | 503>;

/** Total over the client statuses a handler can answer with. */
export const HANDLER_CLIENT_STATUS_REASON = {
  400: "request_invalid",
  401: "access_denied",
  402: "usage_limited",
  403: "access_denied",
  404: "not_found",
  409: "conflict",
  413: "request_invalid",
  422: "request_invalid",
  428: "precondition_required",
  429: "rate_limited",
} as const satisfies Record<HandlerClientStatus, FailureReason>;

/** What the framework itself answered, before or after a handler ran. */
export type FrameworkFailure =
  | "request_malformed"
  | "request_validation"
  | "response_invalid"
  | "route_not_found";

/**
 * AWS SDK service exception names. The name is the exception's code, and it
 * is kept in fields only when the exception also carries `$fault`: any error
 * can be named `ThrottlingException`.
 */
const AWS_EXCEPTION_NAMES = [
  "AccessDeniedException",
  "InternalServerException",
  "ModelNotReadyException",
  "ModelStreamErrorException",
  "ModelTimeoutException",
  "ResourceNotFoundException",
  "ServiceQuotaExceededException",
  "ServiceUnavailableException",
  "ThrottlingException",
  "ValidationException",
] as const;

export type AwsExceptionName = (typeof AWS_EXCEPTION_NAMES)[number];

const AWS_FAULTS: ReadonlySet<string> = new Set(["client", "server"]);

type ReasonLookup = (key: string | undefined) => FailureReason | undefined;

// Own keys only, so a code named `toString` or `__proto__` reads as unknown.
const reasonLookup = (
  table: Readonly<Record<string, FailureReason>>,
): ReasonLookup => {
  const reasons = new Map(Object.entries(table));
  return (key) => (key === undefined ? undefined : reasons.get(key));
};

// --- Sink handles -------------------------------------------------------------

export type OutputPolicy = {
  readonly severity: "ERROR" | "WARN";
  readonly capture: boolean;
};

/**
 * Local, non-domain outcomes a sink may expect. A domain meaning is declared
 * at its boundary instead, where it holds for every sink.
 */
const EXPECTED_REASONS = [
  "optional_file_absent",
  "client_disconnected",
] as const satisfies readonly FailureReason[];

export type ExpectedReason = (typeof EXPECTED_REASONS)[number];

type ExpectableCode =
  | keyof typeof NETWORK_ERROR_CODE_REASON
  | keyof typeof REDIS_ERROR_CODE_REASON
  | PgDriverCode
  | "ENOENT";

type ErrorClass = abstract new (...args: never) => Error;

/**
 * Closed evidence only: a code from the finite vocabulary, an owned
 * constructor, or the request's own cancellation signal. Never a class-name
 * string or a message test, so an expectation cannot become a second grading
 * vocabulary.
 */
type ExpectedMatch =
  | { readonly code: ExpectableCode }
  | { readonly ctor: ErrorClass }
  | { readonly requestAborted: true };

export type FailureExpectation = {
  readonly match: ExpectedMatch;
  /** Nodes below the failure node the match may sit at. */
  readonly depth?: 0 | 1;
  readonly reason: ExpectedReason;
};

type FailureSinkSpec = {
  /** A label. Never a semantic switch: grading ignores it. */
  readonly event: string;
  readonly expected: readonly FailureExpectation[];
  /** Output pinned to what the site emitted before it migrated. */
  readonly legacy?: OutputPolicy;
};

class FailureSinkHandle {
  // Private, so the class is nominal: a structurally identical object literal
  // is not a handle, and only `failureSink` constructs one.
  readonly #spec: Readonly<FailureSinkSpec>;

  constructor({ event, expected, legacy }: FailureSinkSpec) {
    this.#spec = Object.freeze({
      event,
      expected: Object.freeze([...expected]),
      ...(legacy === undefined ? {} : { legacy }),
    });
  }

  get event(): string {
    return this.#spec.event;
  }

  get expected(): readonly FailureExpectation[] {
    return this.#spec.expected;
  }

  get legacy(): OutputPolicy | undefined {
    return this.#spec.legacy;
  }
}

export type FailureSink = FailureSinkHandle;

/**
 * The only way to create a sink handle. Handles are module-level constants,
 * so there is no global table, glob key or default policy to fall back to.
 */
export const failureSink = (spec: FailureSinkSpec): FailureSink => {
  const handle = new FailureSinkHandle(spec);
  Object.freeze(handle);
  return handle;
};

// --- Grading ------------------------------------------------------------------

export type FailureRule =
  | "brand"
  | "expected"
  | "framework"
  | "handler_code"
  | "handler_status"
  | "infra"
  | "infra_under_panic"
  | "unclassified"
  | "unobserved";

export type FailureGrading = {
  readonly grade: FailureGrade;
  readonly reason: FailureReason;
  readonly rule: FailureRule;
  /** The chain position the deciding evidence sat at. */
  readonly evidenceDepth: number;
};

export type FailureRequestState = {
  readonly answeredStatus?: number | undefined;
  readonly framework?: FrameworkFailure | undefined;
  /** From the request's own AbortSignal, never from an error's name. */
  readonly requestAborted?: boolean | undefined;
};

const graded = (
  reason: FailureReason,
  rule: FailureRule,
  evidenceDepth: number,
): FailureGrading => ({
  grade: failureGradeOf(reason),
  reason,
  rule,
  evidenceDepth,
});

const hasPrototype = (node: EvidenceNode, errorClass: ErrorClass): boolean => {
  const prototype: unknown = errorClass.prototype;
  return node.prototypes.some((candidate) => candidate === prototype);
};

const isTransportWrapper = (node: EvidenceNode): boolean =>
  TRANSPORT_WRAPPERS.some((wrapper) => hasPrototype(node, wrapper));

const TRANSPARENT_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "DrizzleQueryError",
  "Error",
]);

/**
 * A wrapper that says nothing of its own: a transport wrapper, or an
 * unclassified generic `Error` / `DrizzleQueryError` that only carries a
 * cause. One that carries a code of its own says something, and a wrapper of
 * any other class may declare a new meaning.
 */
const isTransparent = (
  node: EvidenceNode,
  next: EvidenceNode | undefined,
): boolean => {
  if (next === undefined) {
    return false;
  }
  if (isTransportWrapper(node)) {
    return true;
  }
  return (
    node.kind === "error" &&
    node.brand === undefined &&
    node.code === undefined &&
    node.className !== undefined &&
    TRANSPARENT_ERROR_CLASSES.has(node.className)
  );
};

const failureNodeIndex = (nodes: readonly EvidenceNode[]): number => {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node !== undefined && !isTransparent(node, nodes[index + 1])) {
      return index;
    }
  }
  return Math.max(nodes.length - 1, 0);
};

// The request pipeline's `resolveHandlerError`, over the snapshot.
const resolvedHandlerNode = (
  nodes: readonly EvidenceNode[],
): { node: EvidenceNode; index: number } | undefined => {
  for (let index = 0; index <= MAX_TRANSPORT_WRAPPER_DEPTH; index++) {
    const node = nodes[index];
    if (node === undefined) {
      return undefined;
    }
    if (node.handler !== undefined) {
      return { node, index };
    }
    if (!isTransportWrapper(node)) {
      return undefined;
    }
  }
  return undefined;
};

const isErrorNode = (node: EvidenceNode): boolean =>
  node.kind === "error" || node.kind === "tagged";

const pgSqlStateReason = reasonLookup(PG_SQL_STATE_REASON);
const codeReason = reasonLookup({
  ...PG_DRIVER_CODE_REASON,
  ...REDIS_ERROR_CODE_REASON,
  ...NETWORK_ERROR_CODE_REASON,
});
const gradedHandlerCodeReason = reasonLookup(GRADED_HANDLER_CODE_REASON);
const handlerClientStatusReason = reasonLookup(HANDLER_CLIENT_STATUS_REASON);

const infraReason = (node: EvidenceNode): FailureReason | undefined => {
  if (!isErrorNode(node)) {
    return undefined;
  }
  if (node.pgProvenance) {
    const sqlStateReason = pgSqlStateReason(node.sqlState);
    if (sqlStateReason !== undefined) {
      return sqlStateReason;
    }
  }
  const reason = codeReason(node.code);
  if (reason !== undefined) {
    return reason;
  }
  if (
    node.domName === "TimeoutError" ||
    node.className === TIMEOUT_CLASS_NAME
  ) {
    return "timeout_unbounded";
  }
  return undefined;
};

const matchesExpectation = (
  nodes: readonly EvidenceNode[],
  failureIndex: number,
  { match, depth = 0 }: FailureExpectation,
  request: FailureRequestState,
): boolean => {
  if ("requestAborted" in match) {
    return request.requestAborted === true;
  }
  for (let offset = 0; offset <= depth; offset++) {
    const node = nodes[failureIndex + offset];
    if (node === undefined) {
      return false;
    }
    if (
      "code" in match
        ? node.code === match.code
        : hasPrototype(node, match.ctor)
    ) {
      return true;
    }
  }
  return false;
};

/**
 * Grade one failure. Ordered, first match wins:
 *
 *  1. a classification brand on the failure node, or on a transparent wrapper
 *     above it. A brand deeper than the failure node is evidence only, so an
 *     unexpected failure that merely wraps an anticipated one stays visible;
 *  2. the sink's own local expectation, at the failure node;
 *  3. a graded `HandlerError` code;
 *  4. a `HandlerError` client status, resolved as the request pipeline
 *     resolves it;
 *  5. infrastructure evidence anywhere in the chain;
 *  6. what the framework answered;
 *  7. otherwise a defect.
 */
export const gradeFailure = (
  evidence: FailureEvidence,
  sink: FailureSink,
  request: FailureRequestState = {},
): FailureGrading => {
  const { nodes } = evidence;
  const failureIndex = failureNodeIndex(nodes);

  for (let index = 0; index <= failureIndex; index++) {
    const brand = nodes[index]?.brand;
    if (brand !== undefined) {
      return graded(brand.reason, "brand", index);
    }
  }

  for (const expectation of sink.expected) {
    if (matchesExpectation(nodes, failureIndex, expectation, request)) {
      return graded(expectation.reason, "expected", failureIndex);
    }
  }

  const resolved = resolvedHandlerNode(nodes);
  if (resolved?.node.handler !== undefined) {
    const { code, status } = resolved.node.handler;
    const handlerCodeReason = gradedHandlerCodeReason(code);
    if (handlerCodeReason !== undefined) {
      return graded(handlerCodeReason, "handler_code", resolved.index);
    }
    const statusReason = handlerClientStatusReason(String(status));
    if (statusReason !== undefined) {
      return graded(statusReason, "handler_status", resolved.index);
    }
  }

  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const reason = node === undefined ? undefined : infraReason(node);
    if (reason !== undefined) {
      const underPanic =
        nodes[0] !== undefined && hasPrototype(nodes[0], Panic);
      return graded(reason, underPanic ? "infra_under_panic" : "infra", index);
    }
  }

  if (request.framework !== undefined) {
    return graded(request.framework, "framework", failureIndex);
  }

  return graded("unclassified", "unclassified", failureIndex);
};

// --- Fields -------------------------------------------------------------------

type FieldValue = number | string;
type Fields = Record<string, FieldValue>;

const UNKNOWN_ERROR_CLASS = "UnknownError";
const GENERIC_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "Error",
  UNKNOWN_ERROR_CLASS,
]);

// A code that passes provenance still has to be a token, not a sentence.
const CODE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/u;
const NODE_SYSTEM_CODE = /^E[A-Z0-9]+$/u;
const SYSCALL_TOKEN = /^[a-z][a-z0-9_]{0,31}$/u;
const OTHER_CODE = "other";

const VOCABULARY_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(NETWORK_ERROR_CODE_REASON),
  ...Object.keys(REDIS_ERROR_CODE_REASON),
  ...Object.keys(PG_DRIVER_CODE_REASON),
  "ENOENT",
]);

const AWS_EXCEPTION_NAME_SET: ReadonlySet<string> = new Set(
  AWS_EXCEPTION_NAMES,
);

const frameValue = (frame: FrameEvidence): string | undefined => {
  switch (frame.kind) {
    case "absent":
      return undefined;
    case "recognized":
      return frame.location;
    case "unrecognized":
      return "";
    default: {
      frame satisfies never;
      return panic(`Unhandled frame evidence: ${String(frame)}`);
    }
  }
};

const isNodeSystemError = (node: EvidenceNode): boolean =>
  node.syscall !== undefined &&
  node.code !== undefined &&
  NODE_SYSTEM_CODE.test(node.code);

/**
 * A code as it may leave the process: from the finite vocabulary, or kept by
 * provenance (a Node system error, a pg driver error, Valkey, an AWS
 * exception, one of this service's own tagged errors). Anything else is
 * `"other"`, whatever it looks like: a syntax check does not make a provider
 * code free of client data.
 */
const safeChainCode = (node: EvidenceNode): string | undefined => {
  const code =
    node.code ??
    (node.awsFault !== undefined && AWS_FAULTS.has(node.awsFault)
      ? node.awsName
      : undefined);
  if (code === undefined) {
    return undefined;
  }
  const kept =
    VOCABULARY_CODES.has(code) ||
    isNodeSystemError(node) ||
    (node.pgProvenance && code.startsWith("ERR_POSTGRES_")) ||
    code.startsWith("ERR_REDIS_") ||
    (node.awsName === code && AWS_EXCEPTION_NAME_SET.has(code)) ||
    node.kind === "tagged";
  return kept && CODE_TOKEN.test(code) ? code : OTHER_CODE;
};

const isHttpStatus = (value: number | undefined): value is number =>
  value !== undefined &&
  Number.isInteger(value) &&
  value >= 100 &&
  value <= 599;

const causeErrorNodes = (
  nodes: readonly EvidenceNode[],
  limit: number,
): EvidenceNode[] => {
  const causes: EvidenceNode[] = [];
  for (const node of nodes.slice(1, limit + 1)) {
    if (!isErrorNode(node)) {
      break;
    }
    causes.push(node);
  }
  return causes;
};

// `deepestCause` walked Errors at most five `.cause` hops down.
const MAX_IDENTITY_CAUSE_DEPTH = 5;
// `errorCauseChainAttributes` walked three.
const MAX_CAUSE_ATTRIBUTE_DEPTH = 3;

/**
 * `pgErrorFields`: the outermost SQLSTATE by shape, plus every schema
 * identifier the chain carries. Schema identifiers name database objects,
 * never row data; `detail`, `hint`, `where` and `query` are never read.
 */
export const pgIdentityFields = ({
  nodes,
}: FailureEvidence): Record<string, string> => {
  const pgNodes = nodes.filter((node) => node.sqlState !== undefined);
  const outermost = pgNodes.at(0);
  if (outermost?.sqlState === undefined) {
    return {};
  }
  const fields: Record<string, string> = {
    "error.cause.pg_code": outermost.sqlState,
  };
  for (const node of pgNodes) {
    for (const property of PG_IDENTIFIER_PROPERTIES) {
      const identifier = node.pgIdentifiers[property];
      if (identifier !== undefined) {
        fields[`error.cause.pg_${property}`] = identifier;
      }
    }
  }
  return fields;
};

/**
 * The grouping and suppression identity's inputs, byte-compatible with the
 * fields every capture has shipped: class, stable code, top frame, the
 * deepest Error cause's class and frame, and the pg fields. A non-Error is
 * `UnknownError` alone. The one deliberate difference is the frame origin
 * filter: a frame outside this build's paths is reported as `""`.
 */
export const identityFields = (
  evidence: FailureEvidence,
): Record<string, string> => {
  const root = evidence.nodes.at(0);
  if (root === undefined || !isErrorNode(root)) {
    return { "error.class": UNKNOWN_ERROR_CLASS };
  }
  const fields: Record<string, string> = {
    "error.class": root.className ?? UNKNOWN_ERROR_CLASS,
    "error.code": root.code ?? root.awsName ?? root.tag,
  };
  const frame = frameValue(root.frame);
  if (frame !== undefined) {
    fields["error.frame"] = frame;
  }
  const deepest = causeErrorNodes(evidence.nodes, MAX_IDENTITY_CAUSE_DEPTH).at(
    -1,
  );
  if (deepest !== undefined) {
    fields["error.cause.class"] = deepest.tag;
    const causeFrame = frameValue(deepest.frame);
    if (causeFrame !== undefined) {
      fields["error.cause.frame"] = causeFrame;
    }
  }
  return { ...fields, ...pgIdentityFields(evidence) };
};

/**
 * `errorSystemFields`: the level-zero type, code, errno and syscall, and the
 * direct cause's type and code.
 */
export const systemFields = (
  evidence: FailureEvidence,
): Record<string, string> => {
  const root = evidence.nodes.at(0);
  const fields: Record<string, string> = {
    "error.type": root?.tag ?? UNKNOWN_ERROR_CLASS,
  };
  if (root === undefined || !isErrorNode(root)) {
    return fields;
  }
  const code = root.code ?? root.awsName;
  if (code !== undefined) {
    fields["error.code"] = code;
  }
  if (root.errno !== undefined) {
    fields["error.errno"] = String(root.errno);
  }
  if (root.syscall !== undefined) {
    fields["error.syscall"] = root.syscall;
  }
  const cause =
    evidence.nodes.at(1) ??
    (evidence.cycleTo === undefined
      ? undefined
      : evidence.nodes.at(evidence.cycleTo));
  if (cause !== undefined) {
    fields["error.cause.type"] = cause.tag;
    const causeCode = isErrorNode(cause)
      ? (cause.code ?? cause.awsName)
      : undefined;
    if (causeCode !== undefined) {
      fields["error.cause.code"] = causeCode;
    }
  }
  return fields;
};

/**
 * `errorCauseChainAttributes`: type and numeric status for up to three
 * Error causes, as the request records have carried them.
 */
export const causeChainAttributes = ({
  nodes,
}: FailureEvidence): Record<string, FieldValue> => {
  const attributes: Record<string, FieldValue> = {};
  const root = nodes.at(0);
  if (root === undefined || !isErrorNode(root)) {
    return attributes;
  }
  for (const [index, cause] of causeErrorNodes(
    nodes,
    MAX_CAUSE_ATTRIBUTE_DEPTH,
  ).entries()) {
    const depth = index + 1;
    const prefix = depth === 1 ? "error.cause" : `error.cause${depth}`;
    attributes[`${prefix}.type`] = cause.tag;
    if (cause.ownStatus !== undefined) {
      attributes[`${prefix}.status_code`] = cause.ownStatus;
    }
  }
  return attributes;
};

/** The level-zero numeric status the request records have carried. */
export const requestErrorStatusFields = ({
  nodes,
}: FailureEvidence): Record<string, number> => {
  const root = nodes.at(0);
  return root !== undefined && isErrorNode(root) && root.ownStatus !== undefined
    ? { "error.status_code": root.ownStatus }
    : {};
};

const firstProviderStatus = (
  nodes: readonly EvidenceNode[],
): { node: EvidenceNode; depth: number } | undefined => {
  for (let depth = 0; depth < nodes.length; depth++) {
    const node = nodes[depth];
    if (node === undefined || node.kind === "primitive") {
      return undefined;
    }
    if (node.providerStatus !== undefined) {
      return { node, depth };
    }
  }
  return undefined;
};

/** `providerStatusFields`: the first provider status in the chain. */
export const providerStatusFieldsOf = ({
  nodes,
}: FailureEvidence): Record<string, string> => {
  const found = firstProviderStatus(nodes);
  return found?.node.providerStatus === undefined
    ? {}
    : { "error.provider.status": String(found.node.providerStatus.status) };
};

export type FingerprintDegradation =
  | "class_generic"
  | "frame_absent"
  | "read_failed"
  | "truncated";

/**
 * Why a grouping identity is weaker than it should be, if it is. A plain
 * Error or a missing frame is valid input, not a regression, so this
 * annotates and counts; it never raises a record of its own.
 */
export const fingerprintDegradation = (
  evidence: FailureEvidence,
): FingerprintDegradation | undefined => {
  if (evidence.truncation === "read_failed") {
    return "read_failed";
  }
  if (evidence.truncation !== "none") {
    return "truncated";
  }
  const identity = identityFields(evidence);
  const errorClass = identity["error.class"];
  if (
    errorClass !== undefined &&
    GENERIC_ERROR_CLASSES.has(errorClass) &&
    identity["error.code"] === errorClass
  ) {
    return "class_generic";
  }
  const frame = identity["error.frame"];
  return frame === undefined || frame === "" ? "frame_absent" : undefined;
};

const chainFields = ({ nodes }: FailureEvidence): Fields => {
  const fields: Fields = {};
  for (const [index, node] of nodes.entries()) {
    // Level zero is already carried by the top-level keys.
    if (index === 0) {
      continue;
    }
    const prefix = `error.chain.${index}`;
    fields[`${prefix}.type`] = node.tag;
    const code = safeChainCode(node);
    if (code !== undefined) {
      fields[`${prefix}.code`] = code;
    }
    if (node.errno !== undefined && Number.isInteger(node.errno)) {
      fields[`${prefix}.errno`] = node.errno;
    }
    if (
      isNodeSystemError(node) &&
      node.syscall !== undefined &&
      SYSCALL_TOKEN.test(node.syscall)
    ) {
      fields[`${prefix}.syscall`] = node.syscall;
    }
    if (node.pgProvenance && node.sqlState !== undefined) {
      fields[`${prefix}.sqlstate`] = node.sqlState;
    }
    const status =
      node.providerStatus?.status ??
      (isHttpStatus(node.ownStatus) ? node.ownStatus : undefined);
    if (status !== undefined) {
      fields[`${prefix}.status`] = status;
    }
    if (node.brand !== undefined) {
      fields[`${prefix}.brand`] = node.brand.reason;
    }
  }
  return fields;
};

/**
 * Every field a failure record carries about the error itself. The legacy
 * projections keep their keys and value types until their consumers move;
 * the canonical keys add the SQLSTATE and provider status with provenance,
 * and one entry per chain level.
 */
export const errorFields = (evidence: FailureEvidence): Fields => {
  const { nodes } = evidence;
  const root = nodes.at(0);
  const fields: Fields = {
    ...systemFields(evidence),
    ...requestErrorStatusFields(evidence),
    ...causeChainAttributes(evidence),
    ...providerStatusFieldsOf(evidence),
    ...identityFields(evidence),
  };
  const pgIndex = nodes.findIndex(
    (node) => node.pgProvenance && node.sqlState !== undefined,
  );
  const pgNode = nodes[pgIndex];
  if (pgNode?.sqlState !== undefined) {
    fields["error.sqlstate"] = pgNode.sqlState;
    fields["error.sqlstate_depth"] = pgIndex;
  }
  const provider = firstProviderStatus(nodes);
  if (provider?.node.providerStatus !== undefined) {
    fields["error.provider.status_source"] =
      provider.node.providerStatus.source;
    fields["error.provider.status_depth"] = provider.depth;
  }
  Object.assign(fields, chainFields(evidence));
  fields["error.chain_depth"] = nodes.length;
  fields["error.truncation"] = evidence.truncation;
  const degradation = fingerprintDegradation(evidence);
  if (degradation !== undefined) {
    fields["error.fingerprint_degraded"] = degradation;
  }
  if (root?.extraction !== undefined) {
    Object.assign(fields, root.extraction);
  }
  return fields;
};

/** The classifier's own fields; always present on an owned record. */
export const failureFields = (
  grading: FailureGrading,
  sink: FailureSink,
): Fields => ({
  "failure.grade": grading.grade,
  "failure.reason": grading.reason,
  "failure.rule": grading.rule,
  "failure.evidence_depth": grading.evidenceDepth,
  "failure.sink": sink.event,
});

// --- Shadow grading for the record helpers ------------------------------------

const RECORD_HELPER_SINK = failureSink({
  event: "record.helper",
  expected: [],
});

/**
 * The grade a failure would get, on the records the legacy field helpers
 * build. The helpers do not know their sink or the severity it logs at, so
 * the keys say "shadow": a record carrying them is still not an owned one.
 */
export const shadowGradeFields = (error: unknown): Record<string, string> => {
  const { grade, reason } = gradeFailure(
    readEvidence(error),
    RECORD_HELPER_SINK,
  );
  return {
    "failure.shadow_grade": grade,
    "failure.shadow_reason": reason,
  };
};
