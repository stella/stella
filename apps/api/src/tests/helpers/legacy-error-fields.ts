// FROZEN: a verbatim copy of the error field helpers as they shipped before
// the failure owner existed (errors/utils.ts, pg-error.ts, ai-error.ts,
// api-handlers.ts at f9469f4651). The failure contract test compares the
// owner's projections against these, so a refactor of the live helpers, or
// their deletion, cannot silently change a field, a value type or a grouping
// identity. Only identifiers that collided between the source files were
// renamed, and the request-field status reader exported. Do not edit the
// logic below; when a projection changes on purpose, the contract test states
// the difference against this copy.

import { isTaggedError, Result } from "better-result";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

// --- errors/error-tag.ts -------------------------------------------------------

const GENERIC_ERROR_NAME = "Error";

const safeReflectGet = (target: object, key: PropertyKey): unknown =>
  Result.try((): unknown => Reflect.get(target, key)).unwrapOr(undefined);

const taggedErrorName = (error: unknown): string | undefined =>
  Result.try(() => (isTaggedError(error) ? error._tag : undefined)).unwrapOr(
    undefined,
  );

/**
 * The name an error class assigns to itself, when it assigns one.
 *
 * `Error.prototype.name` is `"Error"`, so a class that never writes `name`
 * reports that generic value. Treat it as "declares nothing" and let the
 * caller fall back to the constructor identifier, which for such a class is
 * the more specific of the two.
 */
const declaredErrorName = (error: Error): string | undefined => {
  const name = safeReflectGet(error, "name");
  return typeof name === "string" && name && name !== GENERIC_ERROR_NAME
    ? name
    : undefined;
};

const constructorIdentifier = (error: Error): string => {
  const constructorValue = safeReflectGet(error, "constructor");
  if (typeof constructorValue !== "function") {
    return GENERIC_ERROR_NAME;
  }
  const name = safeReflectGet(constructorValue, "name");
  return typeof name === "string" && name ? name : GENERIC_ERROR_NAME;
};

const hasNumericSuffix = (value: string, prefix: string): boolean => {
  if (!value.startsWith(prefix)) {
    return false;
  }
  const suffix = value.slice(prefix.length);
  return (
    suffix.length > 0 &&
    Array.from(suffix).every((char) => char >= "0" && char <= "9")
  );
};

/**
 * Name an error class.
 *
 * Prefers the `name` the class declares over its constructor's identifier: an
 * identifier is a build artifact, `name` is a string literal the class writes
 * onto every instance. The two diverge silently in three ways, each of which
 * renames the class without touching `name`:
 *  - a minifier rewrites the binding, so a dependency ships
 *    `class e extends Error { … this.name = "Panic" }`;
 *  - an anonymous class expression is named after whatever it is assigned to,
 *    so `var x = class extends Error {}` reports `"x"`;
 *  - a bundler flattens modules into one scope and suffixes the loser of a
 *    name collision, turning `DrizzleQueryError` into `DrizzleQueryError2`.
 *
 * Every such name is local to one build of one bundle, so none of them
 * identifies the class across builds, and none of them can be grepped for.
 * The declared name survives all three. Because `Error.name` is writable, a
 * declared name is used only when a tagged error vouches for it or the
 * constructor identifier proves the same name, optionally with the numeric
 * suffix emitted by the bundler. This keeps caller-controlled values out of
 * telemetry and persisted error codes.
 */
const errorClassName = (error: Error): string => {
  const taggedName = taggedErrorName(error);
  if (taggedName !== undefined) {
    return taggedName;
  }

  const declaredName = declaredErrorName(error);
  const constructorName = constructorIdentifier(error);
  if (
    declaredName !== undefined &&
    (declaredName === constructorName ||
      hasNumericSuffix(constructorName, declaredName))
  ) {
    return declaredName;
  }
  return constructorName;
};

/**
 * Extract a safe, structural error identifier for observability.
 *
 * Returns the TaggedError `_tag`, the error's class name, or
 * "UnknownError". Never includes messages, causes, or stack
 * traces; those may contain privileged document content, file
 * names, or client data that must not reach analytics dashboards.
 */
const errorTag = (error: unknown): string => {
  const taggedName = taggedErrorName(error);
  if (taggedName !== undefined) {
    return taggedName;
  }
  if (error instanceof Error) {
    return errorClassName(error);
  }
  return "UnknownError";
};

// --- pg-error.ts ---------------------------------------------------------------

// A SQLSTATE is exactly five characters from the class/subclass alphabet
// (`0`-`9`, `A`-`Z`). Shape alone is not enough: five-letter Node system
// codes (`EPIPE`, `EPERM`) fit it too, so the check also requires at least
// one digit (every standard SQLSTATE contains one; Node codes are all
// letters) and `sqlStateOf` skips nodes carrying `syscall`, which every Node
// system error has and no Postgres driver error does.
const PG_SQLSTATE_PATTERN = /^(?=.*[0-9])[0-9A-Z]{5}$/u;

const MAX_CAUSE_DEPTH = 6;

const readProperty = (value: object, key: string): unknown => {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
};

const readNonEmptyString = (value: object, key: string): string | undefined => {
  const raw = readProperty(value, key);
  return typeof raw === "string" && raw !== "" ? raw : undefined;
};

// Returns a node's SQLSTATE when it is shaped like a Postgres driver error.
// Bun's `Bun.sql` puts the SQLSTATE in `errno` (`code` is a generic category
// like "ERR_POSTGRES_SERVER_ERROR"); pg/PGlite put it in `code`. Prefer
// `errno`, fall back to `code`, and require the SQLSTATE shape so
// non-Postgres codes are ignored.
const sqlStateOf = (node: object): string | undefined => {
  if (readProperty(node, "syscall") !== undefined) {
    return undefined;
  }
  const errno = readNonEmptyString(node, "errno");
  if (errno !== undefined && PG_SQLSTATE_PATTERN.test(errno)) {
    return errno;
  }
  const code = readNonEmptyString(node, "code");
  if (code !== undefined && PG_SQLSTATE_PATTERN.test(code)) {
    return code;
  }
  return undefined;
};

/**
 * Every node in `error`'s `.cause` chain, outermost first.
 *
 * Bounded by `MAX_CAUSE_DEPTH` and guarded by `seen`: a self-referential
 * `cause` is an infinite loop on a runtime with proper tail calls, not a
 * fast throw, so the cycle guard is load-bearing rather than defensive.
 * Never throws: property access is fully guarded.
 */
const causeChain = (error: unknown): object[] => {
  const nodes: object[] = [];
  const seen = new WeakSet<object>();
  let current: unknown = error;
  let depth = 0;

  while (
    current !== null &&
    typeof current === "object" &&
    depth < MAX_CAUSE_DEPTH &&
    !seen.has(current)
  ) {
    seen.add(current);
    nodes.push(current);
    current = readProperty(current, "cause");
    depth += 1;
  }

  return nodes;
};

type PgErrorNode = { node: object; sqlState: string };

/**
 * Every node in `error`'s `.cause` chain, outermost first, that is shaped like
 * a Postgres driver error.
 *
 * Matching walks the chain rather than testing for a `DrizzleQueryError`
 * wrapper because only failures raised inside prepared-query execution are
 * wrapped. The transaction lifecycle runs through the client's own `begin`,
 * so a failure while acquiring a connection or running `BEGIN`, `COMMIT`, or
 * `ROLLBACK` arrives as the bare driver error. `COMMIT` is where Postgres
 * reports deferred constraint violations and serialization failures, so a
 * reader gated on the wrapper misses exactly the codes worth acting on.
 *
 * Every helper below reads the chain through this one walk, so a SQLSTATE the
 * observability fields can see is also one the predicates can match. Never
 * throws: property access is fully guarded.
 */
const pgErrorNodes = (error: unknown): PgErrorNode[] => {
  const nodes: PgErrorNode[] = [];
  for (const node of causeChain(error)) {
    const sqlState = sqlStateOf(node);
    if (sqlState !== undefined) {
      nodes.push({ node, sqlState });
    }
  }
  return nodes;
};

// Schema identifiers Postgres attaches to a server error. These name database
// objects, never row data, so they are safe to ship to a log sink. `detail`,
// `hint`, `where`, `internalQuery`, and `query` are deliberately excluded:
// they can embed the offending row's column values.
const PG_SAFE_STRING_FIELDS = [
  { key: "error.cause.pg_severity", property: "severity" },
  { key: "error.cause.pg_constraint", property: "constraint" },
  { key: "error.cause.pg_table", property: "table" },
  { key: "error.cause.pg_column", property: "column" },
  { key: "error.cause.pg_schema", property: "schema" },
  { key: "error.cause.pg_routine", property: "routine" },
] as const;

const readSafePgStringFields = (node: object): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const { key, property } of PG_SAFE_STRING_FIELDS) {
    const value = readNonEmptyString(node, property);
    if (value !== undefined) {
      fields[key] = value;
    }
  }
  return fields;
};

/**
 * Extract safe, structured fields from a Postgres driver error anywhere in an
 * error's `.cause` chain, for observability. A failed query wraps the driver
 * error (`DrizzleQueryError`), so its SQLSTATE lives one or more `.cause` hops
 * down and would otherwise never reach the log sink.
 *
 * Returns the SQLSTATE under `error.cause.pg_code` plus any present schema
 * identifiers (severity, constraint, table, column, schema, routine). Every
 * key is chosen to NOT match the logger's PII redaction regex, so the fields
 * survive `sanitizeLogAttributes`. Returns `{}` when no Postgres error is
 * found. Never throws: property access is fully guarded.
 */
export const pgErrorFields = (error: unknown): Record<string, string> => {
  const nodes = pgErrorNodes(error);
  const outermost = nodes.at(0);
  if (outermost === undefined) {
    return {};
  }

  const fields: Record<string, string> = {
    "error.cause.pg_code": outermost.sqlState,
  };
  for (const { node } of nodes) {
    Object.assign(fields, readSafePgStringFields(node));
  }
  return fields;
};

// --- errors/utils.ts ------------------------------------------------------------

export const errorSystemFields = (error: unknown): Record<string, string> => {
  const fields: Record<string, string> = { "error.type": errorTag(error) };
  if (!(error instanceof Error)) {
    return fields;
  }
  const code = safeErrorCode(error);
  if (code !== undefined) {
    fields["error.code"] = code;
  }
  const errno = safeErrorNumberProperty(error, "errno");
  if (errno !== undefined) {
    fields["error.errno"] = String(errno);
  }
  const syscall = safeErrorStringProperty(error, "syscall");
  if (syscall !== undefined) {
    fields["error.syscall"] = syscall;
  }
  const cause = safeErrorCause(error);
  if (cause !== undefined) {
    fields["error.cause.type"] = errorTag(cause);
    if (cause instanceof Error) {
      const causeCode = safeErrorCode(cause);
      if (causeCode !== undefined) {
        fields["error.cause.code"] = causeCode;
      }
    }
  }
  return fields;
};

const safeErrorProperty = (error: Error, key: string): unknown => {
  try {
    return key in error ? Reflect.get(error, key) : undefined;
  } catch {
    return undefined;
  }
};

const safeErrorStringProperty = (
  error: Error,
  key: string,
): string | undefined => {
  const value = safeErrorProperty(error, key);
  return typeof value === "string" && value !== "" ? value : undefined;
};

const safeErrorNumberProperty = (
  error: Error,
  key: string,
): number | undefined => {
  const value = safeErrorProperty(error, key);
  return typeof value === "number" ? value : undefined;
};

const safeErrorCause = (error: Error): unknown => {
  try {
    return Reflect.get(error, "cause");
  } catch {
    return undefined;
  }
};

const safeErrorCode = (error: Error): string | undefined =>
  safeErrorStringProperty(error, "code") ??
  // An AWS SDK service exception carries its service error code as `name`,
  // and marks itself with `$fault`; any other error's name is its class.
  (safeErrorProperty(error, "$fault") === undefined
    ? undefined
    : safeErrorStringProperty(error, "name"));

/**
 * The message exactly as the stack's own header carries it, empty string
 * included. `safeErrorMessage` reports an empty message as absent, which is
 * what the telemetry fields want; frame parsing needs the distinction, because
 * an error raised without a message still has a stack whose header line is the
 * bare class name and whose frames follow it.
 */
const safeErrorMessageText = (error: Error): string | undefined => {
  const value = safeErrorProperty(error, "message");
  return typeof value === "string" ? value : undefined;
};

const safeErrorStack = (error: Error): string | undefined =>
  safeErrorStringProperty(error, "stack");

export type ErrorFingerprint = Record<string, string>;

const STACK_FRAME_PREFIX = "at ";

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

const stackFrameLines = (error: Error, stack: string): string[] => {
  const message = safeErrorMessageText(error);
  if (message === undefined) {
    return [];
  }

  const lines = stack.split("\n");
  const firstLine = lines.at(0);
  if (firstLine === undefined) {
    return [];
  }

  if (message === "") {
    const name = safeErrorStringProperty(error, "name");
    if (
      name === undefined ||
      name.includes("\n") ||
      name.includes("\r") ||
      name !== errorClassName(error) ||
      firstLine !== name
    ) {
      return [];
    }
    return lines.slice(1);
  }

  const messageLines = message.split("\n");
  const firstMessageLine = messageLines.at(0);
  if (firstMessageLine && !firstLine.endsWith(firstMessageLine)) {
    return [];
  }

  return lines.slice(messageLines.length);
};

const topStackFrame = (error: Error): string | undefined => {
  try {
    const stack = safeErrorStack(error);
    if (stack === undefined) {
      return undefined;
    }
    for (const line of stackFrameLines(error, stack)) {
      const location = frameLocation(line);
      if (location) {
        return location;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const stableErrorCode = (error: Error): string =>
  safeErrorCode(error) ?? errorTag(error);

const deepestCause = (error: Error): Error | undefined => {
  try {
    const seen = new WeakSet<object>([error]);
    let current = safeErrorCause(error);
    let deepest: Error | undefined;
    let depth = 0;
    while (current instanceof Error && depth < 5 && !seen.has(current)) {
      seen.add(current);
      deepest = current;
      current = safeErrorCause(current);
      depth += 1;
    }
    return deepest;
  } catch {
    return undefined;
  }
};

export const errorFingerprint = (error: unknown): ErrorFingerprint => {
  if (!(error instanceof Error)) {
    return { "error.class": "UnknownError" };
  }
  const fingerprint: ErrorFingerprint = {
    "error.class": errorClassName(error),
    "error.code": stableErrorCode(error),
  };
  const frame = topStackFrame(error);
  if (frame !== undefined) {
    fingerprint["error.frame"] = frame;
  }
  const cause = deepestCause(error);
  if (cause) {
    // A wrapper (`UnhandledException`, a boundary TaggedError) otherwise
    // hides what actually failed: the tag is structural, so it ships under
    // the same contract as `error.class`. Deliberately absent from the
    // grouping fingerprint and the suppression key — the wrap site is the
    // defect's identity, the cause its detail.
    fingerprint["error.cause.class"] = errorTag(cause);
    const causeFrame = topStackFrame(cause);
    if (causeFrame !== undefined) {
      fingerprint["error.cause.frame"] = causeFrame;
    }
  }
  // A Drizzle query failure wraps the driver's PostgresError as a cause; its
  // SQLSTATE and schema identifiers are the actionable, non-PII detail. Without
  // this the 5xx fingerprint carries only error types, and diagnosis needs the
  // RDS server logs.
  Object.assign(fingerprint, pgErrorFields(error));
  return fingerprint;
};

// --- ai-error.ts ----------------------------------------------------------------

const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;
const HTTP_STATUS_STRING_PATTERN = /^[1-5]\d{2}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const isHttpStatus = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= HTTP_STATUS_MIN &&
  value <= HTTP_STATUS_MAX;

const httpStatusFromString = (value: unknown): number | null => {
  if (typeof value !== "string" || !HTTP_STATUS_STRING_PATTERN.test(value)) {
    return null;
  }
  const status = Number(value);
  return isHttpStatus(status) ? status : null;
};

const httpStatusFromValue = (value: unknown): number | null => {
  if (isHttpStatus(value)) {
    return value;
  }
  return httpStatusFromString(value);
};

const providerStatusCode = (error: unknown): number | null => {
  if (!isRecord(error)) {
    return null;
  }

  // A `HandlerError` answers with a status of this service's own: the AI stack
  // wraps a provider failure in a fixed 502 and keeps the provider's status in
  // `code`. Reading `status` off one names every wrapped failure by the
  // wrapper, so only the provider-owned fields below are read for it.
  if (!HandlerError.is(error)) {
    // Range-checked like the nested body fields below: an integer outside the
    // HTTP range is not a status, and treating one as one both mis-names the
    // failure (>= 500 would read as a provider outage) and puts a meaningless
    // number in the failure log.
    const statusCode = error["statusCode"];
    if (isHttpStatus(statusCode)) {
      return statusCode;
    }

    const status = error["status"];
    if (isHttpStatus(status)) {
      return status;
    }
  }

  // An AWS SDK service exception (Bedrock) keeps the response status in its
  // `$metadata`.
  const metadata = error["$metadata"];
  if (isRecord(metadata)) {
    const metadataStatus = metadata["httpStatusCode"];
    if (isHttpStatus(metadataStatus)) {
      return metadataStatus;
    }
  }

  // TanStack's RUN_ERROR contract carries `code` as a string, while raw
  // provider events can carry the same HTTP status as a number. Accept either
  // representation here; symbolic provider codes still need an explicit
  // classification.
  const codeStatus = httpStatusFromValue(error["code"]);
  if (codeStatus !== null) {
    return codeStatus;
  }

  // A provider response body nests the status one level down, as
  // `{ error: { code, message, status } }`, where `code` is the HTTP status and
  // `status` its symbolic name. Only an integer inside the HTTP range counts,
  // so a body whose `code` is symbolic ("insufficient_quota") or an
  // application error number still falls through to the cause walk.
  const body = error["error"];
  if (isRecord(body)) {
    const bodyStatus = body["status"];
    if (isHttpStatus(bodyStatus)) {
      return bodyStatus;
    }
    const bodyCode = httpStatusFromValue(body["code"]);
    if (bodyCode !== null) {
      return bodyCode;
    }
  }

  return null;
};

const errorCause = (error: unknown): unknown => {
  if (!isRecord(error)) {
    return undefined;
  }
  return error["cause"];
};

// The first provider status in the cause chain, walked exactly as
// `classifyAIError` walks it so the status a failure is logged with is the
// one the classifier judged it by.
const providerStatusCodeFromCauseChain = (error: unknown): number | null => {
  const seen = new Set<object>();
  let candidate = error;
  while (isRecord(candidate) && !seen.has(candidate)) {
    seen.add(candidate);
    const status = providerStatusCode(candidate);
    if (status !== null) {
      return status;
    }
    candidate = errorCause(candidate);
  }
  return null;
};

export const providerStatusFields = (
  error: unknown,
): Record<string, string> => {
  const status = providerStatusCodeFromCauseChain(error);
  return status === null ? {} : { "error.provider.status": String(status) };
};

// --- api-handlers.ts ------------------------------------------------------------

export const getErrorStatusCode = (error: Error): number | undefined => {
  try {
    if ("statusCode" in error) {
      const statusCode: unknown = Reflect.get(error, "statusCode");
      if (typeof statusCode === "number") {
        return statusCode;
      }
    }

    if ("status" in error) {
      const statusValue: unknown = Reflect.get(error, "status");
      if (typeof statusValue === "number") {
        return statusValue;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
};

/** How far up `.cause` the structural walk goes. */
const MAX_CAUSE_ATTRIBUTE_DEPTH = 3;

/**
 * Structural attributes for an error's `.cause` chain, so nested
 * wrappers do not hide the underlying failure.
 *
 * Each level records its type and, when it carries one, its status.
 * The status is what makes the level useful: a `toXError(cause)`
 * wrapper and its cause are usually both `HandlerError`, so type
 * alone repeats one uninformative string while the wrapper's own
 * generic 500 is the only status logged. The cause's 403
 * (misconfiguration), 400 (unsupported input) or 502 (upstream run
 * failure) is what names the failure. A status is a number, so this
 * stays as non-PII as the rest of the sink.
 */
export const errorCauseChainAttributes = (
  error: Error,
): Record<string, string | number> => {
  const attributes: Record<string, string | number> = {};
  const seen = new WeakSet<object>([error]);
  let cause = safeErrorCause(error);
  let depth = 1;

  while (
    cause instanceof Error &&
    depth <= MAX_CAUSE_ATTRIBUTE_DEPTH &&
    !seen.has(cause)
  ) {
    seen.add(cause);
    const prefix = depth === 1 ? "error.cause" : `error.cause${depth}`;
    attributes[`${prefix}.type`] = errorTag(cause);
    const causeStatusCode = getErrorStatusCode(cause);
    if (causeStatusCode !== undefined) {
      attributes[`${prefix}.status_code`] = causeStatusCode;
    }
    cause = safeErrorCause(cause);
    depth++;
  }

  return attributes;
};

// --- analytics/capture.ts ---------------------------------------------------------

const ERROR_IDENTITY_COMPONENTS = [
  "error.class",
  "error.code",
  "error.frame",
  "error.cause.frame",
  "error.cause.pg_code",
] as const;

/** The grouping and suppression identity capture derived from these fields. */
export const legacyErrorIdentity = (fields: Record<string, string>): string =>
  ERROR_IDENTITY_COMPONENTS.map((key) => fields[key] ?? "").join("|");
