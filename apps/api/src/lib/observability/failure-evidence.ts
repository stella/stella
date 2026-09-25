/**
 * One bounded, read-once snapshot of what an error carries, for every failure
 * sink to read.
 *
 * Capture, log fields, the metric and the request lifecycle each used to walk
 * the error themselves, to different depths, through different guards, over
 * Errors only or over any object. A sink that walked less than another lost
 * the cause, the SQLSTATE or the provider status, and the fix was always one
 * sink at a time. This reads the chain once: outermost first, over objects,
 * at most `MAX_EVIDENCE_DEPTH` nodes, each property read once inside a guard,
 * into primitives. A revoked Proxy, a throwing getter or one that changes on
 * every read cannot yield two different answers, or an exception, at a sink.
 *
 * Env-free: the runner's modules and the pg predicates import it.
 *
 * Nothing here is safe to ship as-is. The snapshot holds raw codes and pg
 * identifiers; the projections in `failure.ts` decide what leaves the process,
 * by provenance. The message is read only to find where the stack's frames
 * start, and is never kept.
 */

import { Result } from "better-result";

import type { FailureBrand } from "@stll/errors";
import { readFailureBrand } from "@stll/errors";

import { errorClassNameFrom } from "@/api/lib/errors/error-tag";
import {
  ExtractionWorkerError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";

export const MAX_EVIDENCE_DEPTH = 6;

// A stack is read from where its frames start, so these bound only the frame
// block: a 1 MB message costs a newline count, never a 1 MB split.
const MAX_STACK_FRAME_BYTES = 8 * 1024;
const MAX_STACK_FRAME_LINES = 64;

// Deep enough for any real class hierarchy; bounded because a Proxy can answer
// `getPrototypeOf` with an endless chain.
const MAX_PROTOTYPE_DEPTH = 16;

const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;
const HTTP_STATUS_STRING_PATTERN = /^[1-5]\d{2}$/u;

// A SQLSTATE is exactly five characters from the class/subclass alphabet
// (`0`-`9`, `A`-`Z`). Shape alone is not enough: five-letter Node system
// codes (`EPIPE`, `EPERM`) fit it too, so the check also requires at least
// one digit (every standard SQLSTATE contains one; Node codes are all
// letters) and `sqlStateFrom` skips nodes carrying `syscall`, which every Node
// system error has and no Postgres driver error does.
const PG_SQLSTATE_PATTERN = /^(?=.*[0-9])[0-9A-Z]{5}$/u;

// Bun's driver files every failure under one of these codes; pg raises a
// `DatabaseError` whose `code` is the SQLSTATE itself. PGlite ships that class
// minified, so it is recognised by the protocol message name the class
// writes onto every instance, together with the server's `severity`.
const PG_DRIVER_CODE_PREFIX = "ERR_POSTGRES_";
const PG_DRIVER_CLASS_NAMES: ReadonlySet<string> = new Set([
  "DatabaseError",
  "PostgresError",
]);
const PG_PROTOCOL_ERROR_NAME = "error";

const DOM_EXCEPTION_CLASS = "DOMException";
const DOM_EXCEPTION_NAMES = ["AbortError", "TimeoutError"] as const;
type DomExceptionName = (typeof DOM_EXCEPTION_NAMES)[number];

const STACK_FRAME_PREFIX = "at ";

// A frame path this build can produce. Anything else (an `eval` with a
// caller-chosen `//# sourceURL`, a data URL) could carry content, so it is
// reported as present but empty.
const RECOGNIZED_FRAME_ORIGIN =
  /^(?:(?:[^\s]*\/)?(?:apps|packages|node_modules)\/|\/app\/|(?:node|bun|native):)/u;

export type EvidenceNodeKind = "error" | "plain" | "primitive" | "tagged";

export type EvidenceTruncation = "cycle" | "depth" | "none" | "read_failed";

export type ProviderStatusSource =
  | "body_code"
  | "body_status"
  | "code"
  | "metadata"
  | "status"
  | "statusCode";

export type ProviderStatus = {
  readonly status: number;
  readonly source: ProviderStatusSource;
};

export type FrameEvidence =
  | { readonly kind: "absent" }
  | { readonly kind: "recognized"; readonly location: string }
  | { readonly kind: "unrecognized" };

export const PG_IDENTIFIER_PROPERTIES = [
  "severity",
  "constraint",
  "table",
  "column",
  "schema",
  "routine",
] as const;

export type PgIdentifierProperty = (typeof PG_IDENTIFIER_PROPERTIES)[number];

export type EvidenceNode = {
  readonly kind: EvidenceNodeKind;
  /** `errorTag` of the node: TaggedError tag, vouched class name, or UnknownError. */
  readonly tag: string;
  /** `errorClassName`, for Error nodes. */
  readonly className: string | undefined;
  readonly domName: DomExceptionName | undefined;
  /** A non-empty string `code`, raw: shipped only by provenance. */
  readonly code: string | undefined;
  /** `name` of an AWS SDK service exception (it carries `$fault`). */
  readonly awsName: string | undefined;
  readonly awsFault: string | undefined;
  readonly errno: number | undefined;
  readonly syscall: string | undefined;
  /** SQLSTATE by shape alone, as the legacy fields read it. */
  readonly sqlState: string | undefined;
  /** Whether the node is a Postgres driver error rather than merely shaped like one. */
  readonly pgProvenance: boolean;
  readonly pgIdentifiers: Readonly<
    Partial<Record<PgIdentifierProperty, string>>
  >;
  /** `statusCode`, else `status`, when numeric: the legacy request-field status. */
  readonly ownStatus: number | undefined;
  readonly providerStatus: ProviderStatus | undefined;
  readonly handler:
    | { readonly status: number; readonly code: string | undefined }
    | undefined;
  readonly brand: FailureBrand | undefined;
  /** The prototype chain, read once; identity checks run against it. */
  readonly prototypes: readonly object[];
  readonly frame: FrameEvidence;
  readonly extraction: Readonly<Record<string, string>> | undefined;
};

export type FailureEvidence = {
  readonly nodes: readonly EvidenceNode[];
  readonly truncation: EvidenceTruncation;
  /** The node the last node's `cause` points back to, on a cycle. */
  readonly cycleTo: number | undefined;
};

type ReadState = { failed: boolean };

const attempt = <TValue>(
  state: ReadState,
  read: () => TValue,
  fallback: TValue,
): TValue => {
  const result = Result.try(read);
  if (Result.isError(result)) {
    state.failed = true;
    return fallback;
  }
  return result.value;
};

const readKey = (state: ReadState, value: object, key: string): unknown =>
  attempt(state, (): unknown => Reflect.get(value, key), undefined);

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const isHttpStatus = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= HTTP_STATUS_MIN &&
  value <= HTTP_STATUS_MAX;

const httpStatusFromValue = (value: unknown): number | undefined => {
  if (isHttpStatus(value)) {
    return value;
  }
  if (typeof value !== "string" || !HTTP_STATUS_STRING_PATTERN.test(value)) {
    return undefined;
  }
  const status = Number(value);
  return isHttpStatus(status) ? status : undefined;
};

type SqlStateParts = { syscall: unknown; errno: unknown; code: unknown };

/**
 * A node's SQLSTATE when it is shaped like a Postgres driver error. Bun's
 * `Bun.sql` puts the SQLSTATE in `errno` (`code` is a generic category like
 * "ERR_POSTGRES_SERVER_ERROR"); pg/PGlite put it in `code`. Prefer `errno`,
 * fall back to `code`, and require the SQLSTATE shape so non-Postgres codes
 * are ignored. The pg predicates read the chain through this same rule.
 */
export const sqlStateFrom = ({
  syscall,
  errno,
  code,
}: SqlStateParts): string | undefined => {
  if (syscall !== undefined) {
    return undefined;
  }
  const errnoValue = nonEmptyString(errno);
  if (errnoValue !== undefined && PG_SQLSTATE_PATTERN.test(errnoValue)) {
    return errnoValue;
  }
  const codeValue = nonEmptyString(code);
  if (codeValue !== undefined && PG_SQLSTATE_PATTERN.test(codeValue)) {
    return codeValue;
  }
  return undefined;
};

type ProviderStatusParts = {
  isHandlerError: boolean;
  statusCode: unknown;
  status: unknown;
  metadataStatus: unknown;
  code: unknown;
  bodyStatus: unknown;
  bodyCode: unknown;
};

/**
 * The provider HTTP status one node carries, with where it was found.
 *
 * A `HandlerError` answers with a status of this service's own: the AI stack
 * wraps a provider failure in a fixed 502 and keeps the provider's status in
 * `code`, so only provider-owned fields are read for it. An AWS SDK exception
 * keeps the status in `$metadata`; TanStack's RUN_ERROR carries it as a
 * numeric string `code`; a provider body nests it as `{ error: { code,
 * status } }`. Every value is range-checked: an integer outside the HTTP range
 * is not a status.
 */
const providerStatusFrom = ({
  isHandlerError,
  statusCode,
  status,
  metadataStatus,
  code,
  bodyStatus,
  bodyCode,
}: ProviderStatusParts): ProviderStatus | undefined => {
  if (!isHandlerError && isHttpStatus(statusCode)) {
    return { status: statusCode, source: "statusCode" };
  }
  if (!isHandlerError && isHttpStatus(status)) {
    return { status, source: "status" };
  }
  if (isHttpStatus(metadataStatus)) {
    return { status: metadataStatus, source: "metadata" };
  }
  const codeStatus = httpStatusFromValue(code);
  if (codeStatus !== undefined) {
    return { status: codeStatus, source: "code" };
  }
  if (isHttpStatus(bodyStatus)) {
    return { status: bodyStatus, source: "body_status" };
  }
  const bodyCodeStatus = httpStatusFromValue(bodyCode);
  return bodyCodeStatus === undefined
    ? undefined
    : { status: bodyCodeStatus, source: "body_code" };
};

const nestedKey = (
  state: ReadState,
  container: unknown,
  key: string,
): unknown =>
  isObject(container) ? readKey(state, container, key) : undefined;

const prototypeChain = (state: ReadState, value: object): object[] => {
  const chain: object[] = [];
  let current = attempt(
    state,
    (): unknown => Object.getPrototypeOf(value),
    null,
  );
  while (isObject(current) && chain.length < MAX_PROTOTYPE_DEPTH) {
    chain.push(current);
    const next = current;
    current = attempt(state, (): unknown => Object.getPrototypeOf(next), null);
  }
  return chain;
};

/**
 * The provider status a value carries at its own level, for the AI
 * classifier's decisions. The same rule the snapshot records, so the status a
 * failure is graded and logged with is the one it is answered with.
 */
export const readProviderStatus = (
  value: unknown,
): ProviderStatus | undefined => {
  if (!isObject(value)) {
    return undefined;
  }
  const state: ReadState = { failed: false };
  const body = readKey(state, value, "error");
  return providerStatusFrom({
    isHandlerError: prototypeChain(state, value).includes(
      HandlerError.prototype,
    ),
    statusCode: readKey(state, value, "statusCode"),
    status: readKey(state, value, "status"),
    metadataStatus: nestedKey(
      state,
      readKey(state, value, "$metadata"),
      "httpStatusCode",
    ),
    code: readKey(state, value, "code"),
    bodyStatus: nestedKey(state, body, "status"),
    bodyCode: nestedKey(state, body, "code"),
  });
};

const isAsciiDigits = (value: string): boolean => {
  if (!value) {
    return false;
  }
  for (const char of value) {
    if (char < "0" || char > "9") {
      return false;
    }
  }
  return true;
};

const hasWhitespace = (value: string): boolean => {
  for (const char of value) {
    if (char.trim() === "") {
      return true;
    }
  }
  return false;
};

const frameLocation = (line: string): string | undefined => {
  const trimmedStart = line.trimStart();
  if (trimmedStart === line || !trimmedStart.startsWith(STACK_FRAME_PREFIX)) {
    return undefined;
  }

  const locationEnd = trimmedStart.endsWith(")")
    ? trimmedStart.length - 1
    : trimmedStart.length;
  const columnSeparator = trimmedStart.lastIndexOf(":", locationEnd - 1);
  if (columnSeparator === -1) {
    return undefined;
  }
  const lineSeparator = trimmedStart.lastIndexOf(":", columnSeparator - 1);
  if (lineSeparator === -1) {
    return undefined;
  }

  const lineNumber = trimmedStart.slice(lineSeparator + 1, columnSeparator);
  const columnNumber = trimmedStart.slice(columnSeparator + 1, locationEnd);
  if (!isAsciiDigits(lineNumber) || !isAsciiDigits(columnNumber)) {
    return undefined;
  }

  const openingParen = trimmedStart.lastIndexOf("(", lineSeparator);
  const locationStart =
    openingParen === -1 ? STACK_FRAME_PREFIX.length : openingParen + 1;
  const location = trimmedStart.slice(locationStart, locationEnd);
  if (!location || hasWhitespace(location)) {
    return undefined;
  }
  // Keep only the code location. A stack symbol can be inferred from a
  // computed property key and therefore carry matter or personal data; Bun
  // also suffixes colliding symbols during bundling, so it is neither safe
  // telemetry nor a stable identity.
  return location;
};

const firstLineOf = (text: string): string => {
  const end = text.indexOf("\n");
  return end === -1 ? text : text.slice(0, end);
};

const countLines = (text: string): number => {
  let lines = 1;
  for (
    let index = text.indexOf("\n");
    index !== -1;
    index = text.indexOf("\n", index + 1)
  ) {
    lines += 1;
  }
  return lines;
};

// Offset of the line after the first `lines` lines, or -1 when the text is
// shorter than that.
const offsetAfterLines = (text: string, lines: number): number => {
  let offset = 0;
  for (let skipped = 0; skipped < lines; skipped++) {
    const newline = text.indexOf("\n", offset);
    if (newline === -1) {
      return -1;
    }
    offset = newline + 1;
  }
  return offset;
};

type StackParts = {
  stack: unknown;
  message: unknown;
  name: unknown;
  className: string;
};

/**
 * Where the stack's frames start. User content may itself contain lines
 * shaped like stack frames, so the message's own lines are skipped by count,
 * after checking the header really is the message; a stack whose header does
 * not match yields no frames rather than a guess.
 */
const frameBlockOffset = ({
  stack,
  message,
  name,
  className,
}: StackParts & { stack: string }): number => {
  if (typeof message !== "string") {
    return -1;
  }
  const header = firstLineOf(stack);
  if (message === "") {
    const declaredName = nonEmptyString(name);
    if (
      declaredName === undefined ||
      declaredName.includes("\n") ||
      declaredName.includes("\r") ||
      declaredName !== className ||
      header !== declaredName
    ) {
      return -1;
    }
    return offsetAfterLines(stack, 1);
  }
  const firstMessageLine = firstLineOf(message);
  if (firstMessageLine && !header.endsWith(firstMessageLine)) {
    return -1;
  }
  return offsetAfterLines(stack, countLines(message));
};

const topFrame = (parts: StackParts): FrameEvidence => {
  const stack = nonEmptyString(parts.stack);
  if (stack === undefined) {
    return { kind: "absent" };
  }
  const offset = frameBlockOffset({ ...parts, stack });
  if (offset === -1) {
    return { kind: "absent" };
  }
  const end = offset + MAX_STACK_FRAME_BYTES;
  const lines = stack.slice(offset, end).split("\n");
  // A line cut at the byte bound could parse as a shorter location.
  if (end < stack.length) {
    lines.pop();
  }
  for (const line of lines.slice(0, MAX_STACK_FRAME_LINES)) {
    const location = frameLocation(line);
    if (location !== undefined) {
      return RECOGNIZED_FRAME_ORIGIN.test(location)
        ? { kind: "recognized", location }
        : { kind: "unrecognized" };
    }
  }
  return { kind: "absent" };
};

const extractionFields = (
  state: ReadState,
  value: object,
): Record<string, string> => {
  const fields: Record<string, string> = {
    mimeType: String(readKey(state, value, "mimeType")),
    sizeBytes: String(readKey(state, value, "sizeBytes")),
  };
  const termination = readKey(state, value, "termination");
  if (isObject(termination)) {
    fields["signalCode"] = String(readKey(state, termination, "signalCode"));
    fields["terminationReason"] = String(readKey(state, termination, "reason"));
    return fields;
  }
  fields["exitCode"] = String(readKey(state, value, "exitCode"));
  return fields;
};

const PRIMITIVE_NODE: EvidenceNode = {
  kind: "primitive",
  tag: "UnknownError",
  className: undefined,
  domName: undefined,
  code: undefined,
  awsName: undefined,
  awsFault: undefined,
  errno: undefined,
  syscall: undefined,
  sqlState: undefined,
  pgProvenance: false,
  pgIdentifiers: {},
  ownStatus: undefined,
  providerStatus: undefined,
  handler: undefined,
  brand: undefined,
  prototypes: [],
  frame: { kind: "absent" },
  extraction: undefined,
};

const isDomExceptionName = (value: unknown): value is DomExceptionName =>
  DOM_EXCEPTION_NAMES.some((name) => name === value);

type ReadNodeResult = { node: EvidenceNode; cause: unknown };

const nodeKind = (isError: boolean, isTagged: boolean): EvidenceNodeKind => {
  if (isTagged) {
    return "tagged";
  }
  return isError ? "error" : "plain";
};

const readNode = (state: ReadState, value: object): ReadNodeResult => {
  const prototypes = prototypeChain(state, value);
  const isError = prototypes.includes(Error.prototype);
  const isHandlerError = prototypes.includes(HandlerError.prototype);
  const rawTag = readKey(state, value, "_tag");
  // `isTaggedError`, over the values read here rather than a second read.
  const isTagged =
    isError &&
    typeof rawTag === "string" &&
    typeof readKey(state, value, "toJSON") === "function";
  const name = readKey(state, value, "name");
  const constructorValue = readKey(state, value, "constructor");
  const className = isError
    ? errorClassNameFrom({
        taggedName: isTagged && typeof rawTag === "string" ? rawTag : undefined,
        name,
        constructorName:
          typeof constructorValue === "function"
            ? readKey(state, constructorValue, "name")
            : undefined,
      })
    : undefined;
  const code = readKey(state, value, "code");
  const errno = readKey(state, value, "errno");
  const syscall = readKey(state, value, "syscall");
  const status = readKey(state, value, "status");
  const statusCode = readKey(state, value, "statusCode");
  const fault = readKey(state, value, "$fault");
  const body = readKey(state, value, "error");
  const codeString = nonEmptyString(code);
  const sqlState = sqlStateFrom({ syscall, errno, code });
  const pgIdentifiers: Partial<Record<PgIdentifierProperty, string>> = {};
  if (sqlState !== undefined) {
    for (const property of PG_IDENTIFIER_PROPERTIES) {
      const identifier = nonEmptyString(readKey(state, value, property));
      if (identifier !== undefined) {
        pgIdentifiers[property] = identifier;
      }
    }
  }
  let ownStatus: number | undefined;
  if (typeof statusCode === "number") {
    ownStatus = statusCode;
  } else if (typeof status === "number") {
    ownStatus = status;
  }
  const node: EvidenceNode = {
    kind: nodeKind(isError, isTagged),
    tag:
      isTagged && typeof rawTag === "string"
        ? rawTag
        : (className ?? "UnknownError"),
    className,
    domName:
      className === DOM_EXCEPTION_CLASS && isDomExceptionName(name)
        ? name
        : undefined,
    code: codeString,
    awsName: fault === undefined ? undefined : nonEmptyString(name),
    awsFault: typeof fault === "string" ? fault : undefined,
    errno: typeof errno === "number" ? errno : undefined,
    syscall: nonEmptyString(syscall),
    sqlState,
    pgProvenance:
      isError &&
      !isTagged &&
      (codeString?.startsWith(PG_DRIVER_CODE_PREFIX) === true ||
        (className !== undefined && PG_DRIVER_CLASS_NAMES.has(className)) ||
        (name === PG_PROTOCOL_ERROR_NAME &&
          sqlState !== undefined &&
          pgIdentifiers.severity !== undefined)),
    pgIdentifiers,
    ownStatus,
    providerStatus: providerStatusFrom({
      isHandlerError,
      statusCode,
      status,
      metadataStatus: nestedKey(
        state,
        readKey(state, value, "$metadata"),
        "httpStatusCode",
      ),
      code,
      bodyStatus: nestedKey(state, body, "status"),
      bodyCode: nestedKey(state, body, "code"),
    }),
    handler: isHandlerError
      ? { status: typeof status === "number" ? status : 0, code: codeString }
      : undefined,
    brand: readFailureBrand(value, prototypes),
    prototypes,
    frame:
      className === undefined
        ? { kind: "absent" }
        : topFrame({
            stack: readKey(state, value, "stack"),
            message: readKey(state, value, "message"),
            name,
            className,
          }),
    extraction: prototypes.includes(ExtractionWorkerError.prototype)
      ? extractionFields(state, value)
      : undefined,
  };
  return { node, cause: readKey(state, value, "cause") };
};

const evidenceCache = new WeakMap<object, FailureEvidence>();

const walk = (error: unknown): FailureEvidence => {
  const state: ReadState = { failed: false };
  const nodes: EvidenceNode[] = [];
  const seen = new Map<object, number>();
  let current = error;
  let truncation: EvidenceTruncation = "none";
  let cycleTo: number | undefined;
  while (nodes.length < MAX_EVIDENCE_DEPTH) {
    if (!isObject(current)) {
      // A primitive cause (a thrown string, `null`) still names that the
      // wrapper had one; `undefined` means it had none.
      if (current !== undefined || nodes.length === 0) {
        nodes.push(PRIMITIVE_NODE);
      }
      break;
    }
    const seenAt = seen.get(current);
    if (seenAt !== undefined) {
      truncation = "cycle";
      cycleTo = seenAt;
      break;
    }
    seen.set(current, nodes.length);
    const { node, cause } = readNode(state, current);
    nodes.push(node);
    current = cause;
    if (nodes.length === MAX_EVIDENCE_DEPTH && current !== undefined) {
      truncation = "depth";
    }
  }
  return {
    nodes,
    truncation: state.failed ? "read_failed" : truncation,
    cycleTo,
  };
};

/**
 * The snapshot for `error`, memoized per error object, so every sink reading
 * one failure reads one answer. Classify an error before it reaches a sink:
 * the snapshot does not see a brand attached afterwards. Never throws.
 */
export const readEvidence = (error: unknown): FailureEvidence => {
  if (!isObject(error)) {
    return walk(error);
  }
  const cached = evidenceCache.get(error);
  if (cached !== undefined) {
    return cached;
  }
  const evidence = walk(error);
  evidenceCache.set(error, evidence);
  return evidence;
};
