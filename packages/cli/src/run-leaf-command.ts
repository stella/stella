// The generic executor every generated leaf command dispatches through (spec 051
// S3/S4). It builds the tool-args object from parsed flags (or the `--input`
// escape hatch), runs the client-side scope precheck, confirms destructive ops,
// calls the MCP endpoint (following cursors under `--all`, bounded by the
// ceilings), and renders the result. Exit codes are set on `process.exitCode`
// directly so stricli's `??=` never overrides them.

import { Result } from "better-result";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { text as readStreamText } from "node:stream/consumers";

import { decodeAccessTokenClaims } from "./auth/jwt.js";
import type { Context } from "./context.js";
import { validateAgainstSchema } from "./json-schema-validate.js";
import {
  callTool,
  type CallToolResult,
  type McpClientError,
} from "./mcp-client.js";
import {
  EXIT_CODES,
  FEATURE_DISABLED_ERROR_CODES,
  MAX_ALL_BYTES,
  MAX_ALL_ITEMS,
  MAX_ALL_PAGES,
  mapHttpStatusExit,
  MCP_ERROR_CODE_EXIT_MAP,
  type ExitCode,
} from "./mcp-constants.js";
import {
  buildRenderPlan,
  jsonlLine,
  renderResult,
  selectFormat,
  type OutputFormat,
  type Writers,
} from "./output.js";
import type { FlagSpec, LeafCommandSpec } from "./route-types.js";

/** stricli flag record key for a FlagSpec: snake/dot path -> camelCase identifier. */
export const flagKey = (spec: Pick<FlagSpec, "prop">): string =>
  spec.prop.replace(/[._](?<char>[a-z0-9])/gu, (_match, char: string) =>
    char.toUpperCase(),
  );

/**
 * Whether a parsed flag value counts as caller-provided when overlaying flags
 * onto `--input`. A scalar flag is provided iff it is not `undefined`. An
 * omitted optional variadic flag parses to `[]` (Stricli) rather than
 * `undefined`, and the CLI has no way to pass an explicit empty array, so an
 * empty repeatable value means "left off" — treating it as provided would
 * overwrite an array supplied through `--input` with `[]`. Both command
 * executors route through here so they cannot diverge on this.
 */
export const flagValueProvided = (
  flagSpec: Pick<FlagSpec, "repeatable">,
  value: unknown,
): boolean => {
  if (value === undefined) {
    return false;
  }
  return !(flagSpec.repeatable && Array.isArray(value) && value.length === 0);
};

/** Reserved global flag keys present on generated commands (spec S1/S3). */
export const RESERVED_FLAG_KEYS = {
  input: "input",
  output: "output",
  json: "json",
  table: "table",
  cursor: "cursor",
  limit: "limit",
  all: "all",
  yes: "yes",
  /** Never prompt; fail closed where a prompt would be needed (spec 049 §3). */
  noInput: "noInput",
  /** Capability leaves only: validate server-side without executing (validateOnly). */
  dryRun: "dryRun",
} as const;

type LeafFlags = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (value: unknown, key: string): string | null => {
  if (!isRecord(value)) {
    return null;
  }
  const field = value[key];
  return typeof field === "string" ? field : null;
};

const arrayField = (value: unknown, key: string): readonly unknown[] => {
  if (!isRecord(value)) {
    return [];
  }
  const field = value[key];
  return Array.isArray(field) ? field : [];
};

/** Bind a command's `Context` streams to the output layer's `Writers`. */
export const writersFor = (context: Context): Writers => ({
  stdout: (text) => {
    context.process.stdout.write(text);
  },
  stderr: (text) => {
    context.process.stderr.write(text);
  },
});

export const setExit = (context: Context, code: ExitCode): void => {
  context.process.exitCode = code;
};

// Read all of stdin to a string (the `@-` / `--input -` escape hatch). Consumes
// `process.stdin` to EOF so the published CLI runs under plain Node.
export const readAllStdin = async (): Promise<string> =>
  await readStreamText(process.stdin);

/** Apply gh-style `@file`/`@-`/`@@` sugar to a string flag value (spec S3). */
const resolveStringValue = async (
  raw: string,
): Promise<Result<string, string>> => {
  if (raw.startsWith("@@")) {
    return Result.ok(raw.slice(1));
  }
  if (raw === "@-") {
    return Result.ok((await readAllStdin()).replace(/\n$/u, ""));
  }
  if (raw.startsWith("@")) {
    const path = raw.slice(1);
    const read = await Result.tryPromise({
      try: async () => await readFile(path, "utf-8"),
      catch: (cause) => cause,
    });
    if (Result.isError(read)) {
      return Result.err(`could not read file ${path}`);
    }
    return Result.ok(read.value);
  }
  return Result.ok(raw);
};

export const setPath = (
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void => {
  const segments = path.split(".");
  let node = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] ?? "";
    const next = node[segment];
    if (isRecord(next)) {
      node = next;
    } else {
      const created: Record<string, unknown> = {};
      node[segment] = created;
      node = created;
    }
  }
  node[segments.at(-1) ?? path] = value;
};

/**
 * True when `path` (dot form, e.g. `body.workspaceId`) already resolves to a
 * defined value inside `target`. Used to decide whether a required flag is
 * satisfied by the `--input` JSON when the flag itself is unset (the flag and
 * the JSON compose; see `runLeafCommand`/`runCapabilityCommand`).
 */
export const hasInputPath = (
  target: Record<string, unknown>,
  path: string,
): boolean => {
  const segments = path.split(".");
  let node: unknown = target;
  for (const segment of segments) {
    if (!isRecord(node)) {
      return false;
    }
    node = node[segment];
  }
  return node !== undefined;
};

type ArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; message: string };

const parseBoundedInt = (
  spec: FlagSpec,
  raw: string,
): Result<number, string> => {
  if (!/^-?\d+$/u.test(raw.trim())) {
    return Result.err(`${spec.flag} expects an integer`);
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (spec.min !== undefined && value < spec.min) {
    return Result.err(`${spec.flag} must be >= ${spec.min}`);
  }
  if (spec.max !== undefined && value > spec.max) {
    return Result.err(`${spec.flag} must be <= ${spec.max}`);
  }
  return Result.ok(value);
};

const parseBoundedNumber = (
  spec: FlagSpec,
  raw: string,
): Result<number, string> => {
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) {
    return Result.err(`${spec.flag} expects a number`);
  }
  if (spec.min !== undefined && value < spec.min) {
    return Result.err(`${spec.flag} must be >= ${spec.min}`);
  }
  if (spec.max !== undefined && value > spec.max) {
    return Result.err(`${spec.flag} must be <= ${spec.max}`);
  }
  return Result.ok(value);
};

/** stricli gives string values for scalar flags; guard against anything else. */
const asFlagString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const coerceArrayFlag = (
  flagSpec: FlagSpec,
  value: unknown,
): Result<unknown, string> => {
  const raw: string[] = [];
  for (const element of Array.isArray(value) ? value : []) {
    const asString = asFlagString(element);
    if (asString === null) {
      return Result.err(`${flagSpec.flag} values must be strings`);
    }
    raw.push(asString);
  }
  if (flagSpec.kind === "string-array") {
    return Result.ok(raw);
  }
  if (flagSpec.kind === "enum-array") {
    const enumValues = flagSpec.enum;
    const allowedValues = enumValues ? new Set(enumValues) : null;
    for (const element of raw) {
      if (allowedValues && !allowedValues.has(element)) {
        return Result.err(
          `${flagSpec.flag} values must each be one of ${enumValues?.join(", ")}`,
        );
      }
    }
    return Result.ok(raw);
  }
  const ints: number[] = [];
  for (const element of raw) {
    const parsed = parseBoundedInt(flagSpec, element);
    if (Result.isError(parsed)) {
      return parsed;
    }
    ints.push(parsed.value);
  }
  return Result.ok(ints);
};

/** Coerce one parsed flag value to its JSON tool-arg value (spec S3). */
export const coerceFlagValue = async (
  flagSpec: FlagSpec,
  value: unknown,
): Promise<Result<unknown, string>> => {
  if (flagSpec.kind === "boolean") {
    return Result.ok(value === true);
  }
  if (
    flagSpec.kind === "string-array" ||
    flagSpec.kind === "enum-array" ||
    flagSpec.kind === "int-array"
  ) {
    return coerceArrayFlag(flagSpec, value);
  }

  const raw = asFlagString(value);
  if (raw === null) {
    return Result.err(`${flagSpec.flag} expects a value`);
  }
  if (flagSpec.kind === "nullable-string") {
    if (raw === "null") {
      return Result.ok(null);
    }
    const resolved = await resolveStringValue(raw);
    return resolved;
  }
  if (flagSpec.kind === "string") {
    const resolved = await resolveStringValue(raw);
    return resolved;
  }
  if (flagSpec.kind === "int") {
    return parseBoundedInt(flagSpec, raw);
  }
  if (flagSpec.kind === "number") {
    return parseBoundedNumber(flagSpec, raw);
  }
  // enum
  if (flagSpec.enum && !flagSpec.enum.includes(raw)) {
    return Result.err(
      `${flagSpec.flag} must be one of ${flagSpec.enum.join(", ")}`,
    );
  }
  return Result.ok(raw);
};

/**
 * Overlay parsed value flags onto `base` (spec S3). `base` is the args object
 * built from `--input` (or `{}` when no `--input` was given): each SET flag is
 * coerced and written at its `prop` path, so an explicit flag WINS over the same
 * path in the JSON. A required flag is satisfied either by being set or by
 * already being present in `base`, so `--input` can carry it. Exported for tests.
 */
export const buildArgsFromFlags = async (
  spec: LeafCommandSpec,
  flags: LeafFlags,
  base: Record<string, unknown> = {},
): Promise<ArgsResult> => {
  const args = base;

  for (const flagSpec of spec.flags) {
    const value = flags[flagKey(flagSpec)];
    if (!flagValueProvided(flagSpec, value)) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- @file/@- reads must stay sequential
    const coerced = await coerceFlagValue(flagSpec, value);
    if (Result.isError(coerced)) {
      return { ok: false, message: coerced.error };
    }
    setPath(args, flagSpec.prop, coerced.value);
  }

  // Enforce required flags (spec S3): unset AND absent from `--input` -> usage
  // error (exit 2 upstream), naming the missing flag.
  for (const flagSpec of spec.flags) {
    if (flagSpec.required && !hasInputPath(args, flagSpec.prop)) {
      return { ok: false, message: `missing required flag ${flagSpec.flag}` };
    }
  }

  return { ok: true, args };
};

const buildArgsFromInput = async ({
  inputRaw,
  writers,
}: {
  inputRaw: string;
  writers: Writers;
}): Promise<Record<string, unknown> | undefined> => {
  let jsonText: string;
  if (inputRaw === "-") {
    jsonText = await readAllStdin();
  } else if (inputRaw.startsWith("@")) {
    const read = await Result.tryPromise({
      try: async () => await readFile(inputRaw.slice(1), "utf-8"),
      catch: (cause) => cause,
    });
    if (Result.isError(read)) {
      writers.stderr(`--input could not read file ${inputRaw.slice(1)}\n`);
      return undefined;
    }
    jsonText = read.value;
  } else {
    jsonText = inputRaw;
  }

  const parsed = Result.try((): unknown => JSON.parse(jsonText));
  if (Result.isError(parsed)) {
    writers.stderr("--input is not valid JSON.\n");
    return undefined;
  }
  if (!isRecord(parsed.value)) {
    writers.stderr("--input must be a JSON object.\n");
    return undefined;
  }
  // Parse only: schema validation runs on the COMPOSED args (after value flags
  // overlay their paths), never on the raw `--input` alone. Validating here would
  // reject a `--input` that legitimately omits a required flag-backed path (e.g.
  // a `matter_id` supplied by `--matter-id`), defeating the compose semantics.
  return parsed.value;
};

export const scopeGranted = ({
  token,
  scope,
}: {
  token: string;
  scope: string;
}): boolean => {
  const claims = decodeAccessTokenClaims(token);
  if (claims?.scope === undefined) {
    // Opaque token or no scope claim: cannot verify locally, let the server rule.
    return true;
  }
  return claims.scope.split(/\s+/u).includes(`stella:${scope}`);
};

export const confirmDestructive = async ({
  context,
  flags,
  writers,
  label,
}: {
  context: Context;
  flags: LeafFlags;
  writers: Writers;
  label: string;
}): Promise<"proceed" | "aborted"> => {
  if (flags[RESERVED_FLAG_KEYS.yes] === true) {
    return "proceed";
  }
  // --no-input never prompts and fails closed: a destructive op (or a
  // confirm-required retry) needs --yes when prompting is disabled (spec 049 §3).
  if (flags[RESERVED_FLAG_KEYS.noInput] === true) {
    writers.stderr(
      `refusing to prompt '${label}' with --no-input; --yes is required\n`,
    );
    return "aborted";
  }
  if (!context.process.stdin.isTTY) {
    writers.stderr("refusing destructive op without --yes on non-TTY\n");
    return "aborted";
  }
  // A TTY confirmation must read a single line: `readAllStdin` waits for EOF,
  // so `y`+Enter would never complete the prompt on a terminal.
  const rl = createInterface({
    input: context.process.stdin,
    output: context.process.stdout,
  });
  const rawAnswer = await rl.question(
    `Run destructive command '${label}'? [y/N] `,
  );
  rl.close();
  const answer = rawAnswer.trim().toLowerCase();
  return answer === "y" || answer === "yes" ? "proceed" : "aborted";
};

export const mapClientErrorExit = (error: McpClientError): ExitCode => {
  if (error.kind === "http") {
    return mapHttpStatusExit(error.httpStatus);
  }
  if (error.kind === "rpc") {
    if (error.rpcCode === -32_602) {
      return EXIT_CODES.validation;
    }
    if (error.rpcCode === -32_601) {
      return EXIT_CODES.notFound;
    }
    return EXIT_CODES.server;
  }
  return EXIT_CODES.server;
};

export const parsePayload = (result: CallToolResult): unknown => {
  const text = result.content.at(0)?.text ?? "";
  const parsed = Result.try((): unknown => JSON.parse(text));
  return Result.isOk(parsed) ? parsed.value : undefined;
};

/** One structured validation issue: dot-path (empty for root) plus reason. */
type ErrorIssue = {
  path: string;
  message: string;
};

/**
 * The structured tool-error envelope:
 * `{ error: { code, message, hint?, issues?, requestId? } }`. `issues` is only
 * present on a `validation_error` and pinpoints the offending fields;
 * `requestId` is the server-side receipt for the failing action, rendered dimly
 * so an operator can correlate it with server logs.
 */
type ErrorEnvelope = {
  code: string;
  message: string;
  hint: string | undefined;
  issues: readonly ErrorIssue[];
  requestId: string | undefined;
};

/**
 * Parse the `issues` array off a `validation_error` envelope. Tolerant: a
 * malformed or absent `issues` yields `[]`, and only well-formed
 * `{ path, message }` entries survive, so an older CLI never breaks on a newer
 * server's payload (and a newer CLI never breaks on an older one that omits it).
 */
const parseErrorIssues = (error: Record<string, unknown>): ErrorIssue[] => {
  const raw = error["issues"];
  if (!Array.isArray(raw)) {
    return [];
  }
  const issues: ErrorIssue[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const path = entry["path"];
    const message = entry["message"];
    if (typeof path === "string" && typeof message === "string") {
      issues.push({ path, message });
    }
  }
  return issues;
};

/**
 * Parse the structured tool-error envelope
 * (`{"error":{"code","message","hint?","issues?","retryable?"}}`) a modern
 * server tags every tool failure with. Unknown fields are ignored, so a newer
 * server that grows the envelope never breaks this parser. Returns `null` for a
 * legacy plain-text or bare-`{code}` error so the caller falls back to today's
 * behavior.
 */
export const errorEnvelope = (payload: unknown): ErrorEnvelope | null => {
  if (!isRecord(payload)) {
    return null;
  }
  const error = payload["error"];
  if (!isRecord(error)) {
    return null;
  }
  const code = error["code"];
  const message = error["message"];
  if (typeof code !== "string" || typeof message !== "string") {
    return null;
  }
  const hint = error["hint"];
  return {
    code,
    message,
    hint: typeof hint === "string" ? hint : undefined,
    issues: parseErrorIssues(error),
    requestId: parseRequestId(error["requestId"]),
  };
};

/**
 * The server mints receipts as `req_` + 32 lowercase-hex chars
 * (apps/api/src/lib/observability/request-context.ts); the range is kept
 * tolerant so a future longer/shorter hex tail still renders. Anything else —
 * in particular a value smuggling ANSI escape sequences from a compromised or
 * untrusted server — is DROPPED entirely, never printed to the terminal.
 */
const REQUEST_ID_SHAPE = /^req_[0-9a-f]{16,64}$/u;

/** A well-formed receipt id, or `undefined` (drop, don't sanitize) otherwise. */
const parseRequestId = (value: unknown): string | undefined =>
  typeof value === "string" && REQUEST_ID_SHAPE.test(value) ? value : undefined;

const RECEIPT_DIM = "\u001B[2m";
const RECEIPT_RESET = "\u001B[0m";

/**
 * The `request id: …` receipt line, dimmed on a TTY and plain on a pipe (so an
 * agent capturing stderr reads a clean, greppable line). Shared by the error
 * path (after the envelope) and the capability write path (after a mutation).
 * Callers only receive ids that passed {@link parseRequestId}, so the value is
 * terminal-safe by construction.
 */
export const requestIdLine = (requestId: string, isTTY: boolean): string =>
  isTTY
    ? `${RECEIPT_DIM}request id: ${requestId}${RECEIPT_RESET}\n`
    : `request id: ${requestId}\n`;

/**
 * Read the `meta.requestId` receipt off a success payload, if present and
 * well-formed (see {@link parseRequestId}; a malformed id is dropped).
 */
export const readRequestReceipt = (payload: unknown): string | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }
  const meta = payload["meta"];
  if (!isRecord(meta)) {
    return undefined;
  }
  return parseRequestId(meta["requestId"]);
};

/**
 * Map a tool `isError` result to an exit class (spec 051 S4). A structured
 * envelope's `error.code` selects the exit class directly from the full
 * code->exit map (validation_error->2, missing_scope->3, feature_disabled->5,
 * not_found->6, confirmation_required->7, rate_limited/unknown_tool/
 * internal_error->4). A legacy server that tags only a bare `code` (or
 * `error.code`) without the full envelope still upgrades a feature-disabled
 * failure from 4 to 5; everything else falls to exit 4. Text is never
 * pattern-matched (it is locale-dependent server output).
 */
export const classifyToolError = (payload: unknown): ExitCode => {
  const envelope = errorEnvelope(payload);
  if (envelope !== null) {
    const mapped = MCP_ERROR_CODE_EXIT_MAP[envelope.code];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  if (!isRecord(payload)) {
    return EXIT_CODES.server;
  }
  const code =
    stringField(payload, "code") ?? stringField(payload["error"], "code");
  if (code !== null && FEATURE_DISABLED_ERROR_CODES.has(code)) {
    return EXIT_CODES.featureDisabled;
  }
  return EXIT_CODES.server;
};

/**
 * True when the tool declares a boolean `confirm` gate in its input schema (the
 * destructive delete_* tools, and `manage_organization` which gates its
 * remove_member action). The generated per-tool flags hide `confirm` (the
 * reserved --yes flow owns it), so after a confirmed destructive op the executor
 * injects `confirm: true` to satisfy the server gate. Injection only runs on a
 * leaf marked `destructive`, so a non-destructive sibling subcommand (e.g.
 * `organization update-settings`, sharing the one schema) never has `confirm`
 * injected even though this returns true for the shared schema.
 */
const specHasConfirmGate = (spec: LeafCommandSpec): boolean => {
  const properties = spec.inputSchema["properties"];
  return isRecord(properties) && "confirm" in properties;
};

/**
 * The re-run hint for a phase-1 two-phase-handshake response, or `null` when it
 * does not apply. Generic over the response fields (no tool-name special case):
 * a hint is produced only for an `approval_required` status carrying a
 * `confirmation_token`, and only on a TTY (off a pipe the token is already on
 * stdout for the caller to thread back). Exported for unit testing the gate.
 */
export const approvalReRunHint = ({
  isTTY,
  payload,
}: {
  isTTY: boolean;
  payload: unknown;
}): string | null => {
  if (
    !isTTY ||
    !isRecord(payload) ||
    payload["status"] !== "approval_required"
  ) {
    return null;
  }
  const token = stringField(payload, "confirmation_token");
  if (token === null) {
    return null;
  }
  return `To approve after human review: re-run with --confirmation-token ${token}`;
};

/** Resolve the effective `OutputFormat` from the reserved output flags + TTY. */
export const readOutputFormat = (
  flags: LeafFlags,
  context: Context,
): OutputFormat => {
  const output = flags[RESERVED_FLAG_KEYS.output];
  return selectFormat({
    flags: {
      output:
        output === "json" || output === "table" || output === "jsonl"
          ? output
          : undefined,
      json: flags[RESERVED_FLAG_KEYS.json] === true,
      table: flags[RESERVED_FLAG_KEYS.table] === true,
    },
    isTTY: context.process.stdout.isTTY,
  });
};

/**
 * Validate the hand-parsed reserved flag VALUES (`--output`, `--limit`) up
 * front, so a mistyped value is a loud usage error (exit 2) instead of being
 * silently dropped from the request. Shared by both executors; returns the
 * stderr message naming the flag, or `null` when everything parses.
 */
export const reservedFlagUsageError = (flags: LeafFlags): string | null => {
  const output = flags[RESERVED_FLAG_KEYS.output];
  if (
    typeof output === "string" &&
    output !== "json" &&
    output !== "table" &&
    output !== "jsonl"
  ) {
    return `--output must be one of: json, table, jsonl (got "${output}")`;
  }
  const limit = flags[RESERVED_FLAG_KEYS.limit];
  if (typeof limit === "string") {
    const trimmed = limit.trim();
    if (!/^\d+$/u.test(trimmed) || Number.parseInt(trimmed, 10) < 1) {
      return `--limit expects a positive integer (got "${limit}")`;
    }
  }
  return null;
};

type AllOutcome = {
  payload: unknown;
  truncated: boolean;
  lastCursor: string | null;
  count: number;
};

/**
 * Follow `nextCursor` under `--all`, concatenating items/text within ceilings.
 * With a `stream` callback (JSONL mode, spec 049 §3) each item is emitted as it
 * is fetched and NOT accumulated, so memory stays bounded independent of page
 * count; the ceilings and truncation semantics are unchanged. Callers that
 * stream ignore `payload` and read `count`/`truncated`/`lastCursor`.
 */
export const followAll = async ({
  windowedText,
  itemsKey,
  baseArgs,
  serverUrl,
  token,
  toolName,
  cursorInto,
  stream,
}: {
  windowedText: boolean;
  itemsKey: string | undefined;
  baseArgs: Record<string, unknown>;
  serverUrl: string;
  token: string;
  /** The tool to call each page (the curated tool, or `invoke_capability`). */
  toolName: string;
  /** Merge a cursor into the base args for the next page (part-aware for capabilities). */
  cursorInto: (
    base: Record<string, unknown>,
    cursor: string,
  ) => Record<string, unknown>;
  stream?: (item: unknown) => void;
}): Promise<Result<AllOutcome, McpClientError>> => {
  const items: unknown[] = [];
  let text = "";
  let firstPayload: Record<string, unknown> = {};
  let cursor: string | null = null;
  let pages = 0;
  let bytes = 0;
  let streamedCount = 0;
  let truncated = false;

  do {
    const args = cursor === null ? baseArgs : cursorInto(baseArgs, cursor);
    // eslint-disable-next-line no-await-in-loop -- each page's cursor comes from the previous response
    const call = await callTool({ serverUrl, token, name: toolName, args });
    if (Result.isError(call)) {
      return Result.err(call.error);
    }
    const payload = parsePayload(call.value);
    if (pages === 0 && isRecord(payload)) {
      firstPayload = payload;
    }
    pages += 1;

    if (windowedText) {
      const chunk = stringField(payload, "text") ?? "";
      bytes += Buffer.byteLength(chunk);
      text += chunk;
    } else if (itemsKey !== undefined) {
      const pageItems = arrayField(payload, itemsKey);
      bytes += Buffer.byteLength(JSON.stringify(pageItems));
      if (stream !== undefined) {
        for (const item of pageItems) {
          stream(item);
        }
        streamedCount += pageItems.length;
      } else {
        items.push(...pageItems);
      }
    }

    cursor = stringField(payload, "nextCursor");

    const collected = stream === undefined ? items.length : streamedCount;
    if (
      pages >= MAX_ALL_PAGES ||
      collected >= MAX_ALL_ITEMS ||
      bytes >= MAX_ALL_BYTES
    ) {
      truncated = cursor !== null;
      break;
    }
  } while (cursor !== null);

  const mergedPayload = windowedText
    ? { text, nextCursor: null }
    : { ...firstPayload, [itemsKey ?? "items"]: items, nextCursor: null };

  const itemCount = stream === undefined ? items.length : streamedCount;
  const count = windowedText ? Buffer.byteLength(text) : itemCount;
  return Result.ok({
    payload: mergedPayload,
    truncated,
    lastCursor: cursor,
    count,
  });
};

/**
 * Follow `--all` and render the outcome (spec S4 + 049 §3). Shared by both
 * executors: under JSONL it streams items to stdout as fetched; otherwise it
 * accumulates and renders one merged payload. The truncation notice always goes
 * to stderr. `cursorInto` lets a capability thread the cursor into its input
 * part; a curated leaf merges it at the top level.
 */
export const streamOrRenderAllPages = async ({
  context,
  writers,
  format,
  windowedText,
  itemsKey,
  baseArgs,
  serverUrl,
  token,
  toolName,
  cursorInto,
}: {
  context: Context;
  writers: Writers;
  format: OutputFormat;
  windowedText: boolean;
  itemsKey: string | undefined;
  baseArgs: Record<string, unknown>;
  serverUrl: string;
  token: string;
  toolName: string;
  cursorInto: (
    base: Record<string, unknown>,
    cursor: string,
  ) => Record<string, unknown>;
}): Promise<void> => {
  const streaming = format === "jsonl" && !windowedText;
  const outcome = await followAll({
    windowedText,
    itemsKey,
    baseArgs,
    serverUrl,
    token,
    toolName,
    cursorInto,
    ...(streaming
      ? {
          stream: (item: unknown) => {
            writers.stdout(jsonlLine(item));
          },
        }
      : {}),
  });
  if (Result.isError(outcome)) {
    writers.stderr(`${outcome.error.message}\n`);
    setExit(context, mapClientErrorExit(outcome.error));
    return;
  }
  if (!streaming) {
    const plan = buildRenderPlan({
      payload: outcome.value.payload,
      itemsKey,
      windowedText,
      singleReadActive: false,
      columns: undefined,
    });
    renderResult({ plan, format, writers, allActive: true });
  }
  if (outcome.value.truncated) {
    writers.stderr(
      `--all truncated at ${outcome.value.count} items/pages; resume with --cursor ${outcome.value.lastCursor}\n`,
    );
  }
};

/**
 * Render a tool `isError` result (spec S4). Shared by curated and capability
 * leaves: results never touch stdout on an error path. A structured envelope
 * renders as agent-readable `error:` / issue / `hint:` lines on stderr; a legacy
 * plain-text error falls back to the raw content. Sets the exit class from the
 * envelope code.
 */
export const renderToolError = ({
  context,
  result,
  writers,
}: {
  context: Context;
  result: CallToolResult;
  writers: Writers;
}): void => {
  const errorPayload = parsePayload(result);
  const envelope = errorEnvelope(errorPayload);
  if (envelope !== null) {
    writers.stderr(`error: ${envelope.message}\n`);
    // Field-level validation issues follow the summary, one indented line each,
    // so an agent can map a failure back to the offending field. A root issue
    // (empty path) renders its message without a bare `: ` prefix.
    for (const issue of envelope.issues) {
      writers.stderr(
        issue.path === ""
          ? `  ${issue.message}\n`
          : `  ${issue.path}: ${issue.message}\n`,
      );
    }
    if (envelope.hint !== undefined) {
      writers.stderr(`hint: ${envelope.hint}\n`);
    }
    if (envelope.requestId !== undefined) {
      writers.stderr(
        requestIdLine(envelope.requestId, context.process.stderr.isTTY),
      );
    }
  } else {
    writers.stderr(`${result.content.at(0)?.text ?? "Tool error"}\n`);
  }
  setExit(context, classifyToolError(errorPayload));
};

const renderCallResult = ({
  context,
  spec,
  result,
  format,
  writers,
}: {
  context: Context;
  spec: LeafCommandSpec;
  result: CallToolResult;
  format: OutputFormat;
  writers: Writers;
}): void => {
  if (result.isError) {
    renderToolError({ context, result, writers });
    return;
  }
  const payload = parsePayload(result);
  if (payload === undefined) {
    writers.stdout(`${result.content.at(0)?.text ?? ""}\n`);
    return;
  }
  const plan = buildRenderPlan({
    payload,
    itemsKey: spec.itemsKey,
    windowedText: spec.windowedText,
    singleReadActive: false,
    columns: undefined,
  });
  renderResult({ plan, format, writers, allActive: false });

  // Generic two-phase handshake affordance (driven by the response fields, not
  // any tool name): a phase-1 `approval_required` response carries a
  // `confirmation_token` the human approves before a phase-2 re-run.
  const hint = approvalReRunHint({
    isTTY: context.process.stdout.isTTY,
    payload,
  });
  if (hint !== null) {
    writers.stderr(`${hint}\n`);
  }
};

/** Run one leaf command end to end. Sets `process.exitCode` per spec S4. */
export const runLeafCommand = async ({
  context,
  flags,
  spec,
}: {
  context: Context;
  flags: LeafFlags;
  spec: LeafCommandSpec;
}): Promise<void> => {
  const writers = writersFor(context);

  const { serverUrl, token } = context;
  if (serverUrl === undefined || token === undefined) {
    writers.stderr("Not signed in. Run 'stella auth login' to authenticate.\n");
    setExit(context, EXIT_CODES.auth);
    return;
  }

  // Reserved flag VALUES fail loudly (exit 2) instead of being silently
  // dropped from the request (e.g. `--limit abc`).
  const reservedUsage = reservedFlagUsageError(flags);
  if (reservedUsage !== null) {
    writers.stderr(`${reservedUsage}\n`);
    setExit(context, EXIT_CODES.validation);
    return;
  }

  // `--input` and value flags COMPOSE: the JSON is the base, then each explicit
  // flag overlays its own path on top (flag wins). This lets a required value
  // flag (e.g. --workspace, advertised on the usage line) coexist with a body
  // passed through --input, instead of forcing the caller to hand-relocate it
  // into the JSON under a different key.
  const inputRaw = flags[RESERVED_FLAG_KEYS.input];
  const argsBase =
    typeof inputRaw === "string"
      ? await buildArgsFromInput({ inputRaw, writers })
      : {};
  if (argsBase === undefined) {
    setExit(context, EXIT_CODES.validation);
    return;
  }
  const built = await buildArgsFromFlags(spec, flags, argsBase);
  if (!built.ok) {
    writers.stderr(`${built.message}\n`);
    setExit(context, EXIT_CODES.validation);
    return;
  }
  let args = built.args;

  if (spec.discriminatorInject !== undefined) {
    args = { ...args, ...spec.discriminatorInject };
  }

  // Validate the COMPOSED args (JSON base + overlaid flags + injected
  // discriminator) against the schema, only when `--input` supplied JSON.
  // Flags-only requests keep relying on the required-flag check plus server
  // validation (unchanged surface).
  if (typeof inputRaw === "string") {
    const validation = validateAgainstSchema(spec.inputSchema, args);
    if (!validation.valid) {
      writers.stderr(
        `--input invalid at ${validation.path}: ${validation.message}\n`,
      );
      setExit(context, EXIT_CODES.validation);
      return;
    }
  }

  // Client-side scope precheck (spec S3): fail before any server call.
  if (spec.scope !== undefined && !scopeGranted({ token, scope: spec.scope })) {
    writers.stderr(
      `Missing scope stella:${spec.scope}. Re-run 'stella auth login' to grant stella:${spec.scope}.\n`,
    );
    setExit(context, EXIT_CODES.auth);
    return;
  }

  const gated = await applyConfirmGates({
    args,
    context,
    flags,
    spec,
    writers,
  });
  if (gated.aborted) {
    setExit(context, EXIT_CODES.aborted);
    return;
  }
  args = gated.args;

  // Windowed-text commands print raw document text by default; only an explicit
  // --json / --output json switches them to a structured envelope (spec S4).
  const explicitJson =
    flags[RESERVED_FLAG_KEYS.json] === true ||
    flags[RESERVED_FLAG_KEYS.output] === "json";
  const format =
    spec.windowedText && !explicitJson
      ? "table"
      : readOutputFormat(flags, context);
  const allActive = spec.paginated && flags[RESERVED_FLAG_KEYS.all] === true;

  // Reserved pagination flags map onto the tool's cursor/limit args (spec S3).
  // Values were validated up front (`reservedFlagUsageError`), so a present
  // `--limit` always parses.
  const cursorFlag = flags[RESERVED_FLAG_KEYS.cursor];
  const limitFlag = flags[RESERVED_FLAG_KEYS.limit];
  if (!allActive && typeof cursorFlag === "string") {
    args["cursor"] = cursorFlag;
  }
  if (typeof limitFlag === "string") {
    args["limit"] = Number.parseInt(limitFlag.trim(), 10);
  }

  if (allActive) {
    await streamOrRenderAllPages({
      context,
      writers,
      format,
      windowedText: spec.windowedText,
      itemsKey: spec.itemsKey,
      baseArgs: args,
      serverUrl,
      token,
      toolName: spec.toolName,
      cursorInto: (base, cursor) => ({ ...base, cursor }),
    });
    return;
  }

  const call = await callTool({ serverUrl, token, name: spec.toolName, args });
  if (Result.isError(call)) {
    writers.stderr(`${call.error.message}\n`);
    setExit(context, mapClientErrorExit(call.error));
    return;
  }

  const retried = await maybeConfirmRetry({
    args,
    call: call.value,
    context,
    flags,
    format,
    serverUrl,
    spec,
    token,
    writers,
  });
  if (retried) {
    return;
  }

  renderCallResult({ context, spec, result: call.value, format, writers });
};

type ConfirmGateOutcome = { aborted: boolean; args: Record<string, unknown> };

/**
 * Pre-call confirm gates:
 *  - a DESTRUCTIVE leaf prompts (or honors --yes) before any server call and
 *    injects `confirm: true` when the schema declares the gate;
 *  - a confirm-PASSTHROUGH leaf (per-target destructiveness, e.g.
 *    `capability invoke`) never prompts upfront, but --yes pre-approves the
 *    server's confirmation_required gate by injecting `confirm: true`; without
 *    --yes the post-call prompt-and-retry flow (`maybeConfirmRetry`) handles it.
 */
const applyConfirmGates = async ({
  args,
  context,
  flags,
  spec,
  writers,
}: {
  args: Record<string, unknown>;
  context: Context;
  flags: LeafFlags;
  spec: LeafCommandSpec;
  writers: Writers;
}): Promise<ConfirmGateOutcome> => {
  if (spec.destructive) {
    const outcome = await confirmDestructive({
      context,
      flags,
      writers,
      label: spec.commandPath.join(" "),
    });
    if (outcome === "aborted") {
      return { aborted: true, args };
    }
    // The human confirmed (or passed --yes): satisfy the server's `confirm`
    // gate so the destructive tool proceeds. Only tools that actually declare
    // the boolean gate get the flag (see `specHasConfirmGate`).
    return specHasConfirmGate(spec)
      ? { aborted: false, args: { ...args, confirm: true } }
      : { aborted: false, args };
  }
  if (
    spec.confirmPassthrough === true &&
    flags[RESERVED_FLAG_KEYS.yes] === true &&
    specHasConfirmGate(spec)
  ) {
    return { aborted: false, args: { ...args, confirm: true } };
  }
  return { aborted: false, args };
};

type ConfirmRetryOptions = {
  args: Record<string, unknown>;
  call: CallToolResult;
  context: Context;
  flags: LeafFlags;
  format: OutputFormat;
  serverUrl: string;
  spec: LeafCommandSpec;
  token: string;
  writers: Writers;
};

/**
 * Confirm-passthrough prompt-and-retry: when a call WITHOUT `confirm` comes
 * back `confirmation_required` on a confirm-passthrough leaf and stdin is a
 * TTY, ask the human exactly like the destructive prompt and retry ONCE with
 * `confirm: true`. Returns true when it fully handled the command (rendered a
 * retry result, a retry transport error, or a terminal abort); false lets the
 * caller render the original envelope, so every non-TTY call keeps today's
 * behavior (exit 7). A declined/refused prompt is terminal — one stderr
 * `aborted` line, exit 7, no envelope render on top — matching the pre-call
 * destructive abort flow and the capability executor.
 */
const maybeConfirmRetry = async ({
  args,
  call,
  context,
  flags,
  format,
  serverUrl,
  spec,
  token,
  writers,
}: ConfirmRetryOptions): Promise<boolean> => {
  if (
    spec.confirmPassthrough !== true ||
    call.isError !== true ||
    args["confirm"] === true ||
    !context.process.stdin.isTTY
  ) {
    return false;
  }
  const envelope = errorEnvelope(parsePayload(call));
  if (envelope?.code !== "confirmation_required") {
    return false;
  }
  const outcome = await confirmDestructive({
    context,
    flags,
    writers,
    label: spec.commandPath.join(" "),
  });
  if (outcome !== "proceed") {
    writers.stderr("aborted\n");
    setExit(context, EXIT_CODES.aborted);
    return true;
  }
  const retry = await callTool({
    serverUrl,
    token,
    name: spec.toolName,
    args: { ...args, confirm: true },
  });
  if (Result.isError(retry)) {
    writers.stderr(`${retry.error.message}\n`);
    setExit(context, mapClientErrorExit(retry.error));
    return true;
  }
  renderCallResult({ context, spec, result: retry.value, format, writers });
  return true;
};
