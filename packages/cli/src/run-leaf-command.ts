// The generic executor every generated leaf command dispatches through (spec 051
// S3/S4). It builds the tool-args object from parsed flags (or the `--input`
// escape hatch), runs the client-side scope precheck, confirms destructive ops,
// calls the MCP endpoint (following cursors under `--all`, bounded by the
// ceilings), and renders the result. Exit codes are set on `process.exitCode`
// directly so stricli's `??=` never overrides them.

import { Result } from "better-result";

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
  type ExitCode,
} from "./mcp-constants.js";
import {
  buildRenderPlan,
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

const writersFor = (context: Context): Writers => ({
  stdout: (text) => {
    context.process.stdout.write(text);
  },
  stderr: (text) => {
    context.process.stderr.write(text);
  },
});

const setExit = (context: Context, code: ExitCode): void => {
  context.process.exitCode = code;
};

const readAllStdin = async (): Promise<string> => await Bun.stdin.text();

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
      try: async () => await Bun.file(path).text(),
      catch: (cause) => cause,
    });
    if (Result.isError(read)) {
      return Result.err(`could not read file ${path}`);
    }
    return Result.ok(read.value);
  }
  return Result.ok(raw);
};

const setPath = (
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
    for (const element of raw) {
      if (flagSpec.enum && !flagSpec.enum.includes(element)) {
        return Result.err(
          `${flagSpec.flag} values must each be one of ${flagSpec.enum.join(", ")}`,
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
const coerceFlagValue = async (
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

/** Build the tool-args object from parsed value flags (spec S3). Exported for tests. */
export const buildArgsFromFlags = async (
  spec: LeafCommandSpec,
  flags: LeafFlags,
): Promise<ArgsResult> => {
  const args: Record<string, unknown> = {};

  for (const flagSpec of spec.flags) {
    const value = flags[flagKey(flagSpec)];
    if (value === undefined) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- @file/@- reads must stay sequential
    const coerced = await coerceFlagValue(flagSpec, value);
    if (Result.isError(coerced)) {
      return { ok: false, message: coerced.error };
    }
    setPath(args, flagSpec.prop, coerced.value);
  }

  // Enforce required flags (spec S3): missing -> usage error (exit 2 upstream).
  for (const flagSpec of spec.flags) {
    if (flagSpec.required && flags[flagKey(flagSpec)] === undefined) {
      return { ok: false, message: `missing required flag ${flagSpec.flag}` };
    }
  }

  return { ok: true, args };
};

const buildArgsFromInput = async ({
  inputRaw,
  spec,
  writers,
}: {
  inputRaw: string;
  spec: LeafCommandSpec;
  writers: Writers;
}): Promise<Record<string, unknown> | undefined> => {
  let jsonText: string;
  if (inputRaw === "-") {
    jsonText = await readAllStdin();
  } else if (inputRaw.startsWith("@")) {
    const read = await Result.tryPromise({
      try: async () => await Bun.file(inputRaw.slice(1)).text(),
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

  const validation = validateAgainstSchema(spec.inputSchema, parsed.value);
  if (!validation.valid) {
    writers.stderr(
      `--input invalid at ${validation.path}: ${validation.message}\n`,
    );
    return undefined;
  }
  return parsed.value;
};

const scopeGranted = ({
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

const confirmDestructive = async ({
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
  if (!context.process.stdin.isTTY) {
    writers.stderr("refusing destructive op without --yes on non-TTY\n");
    return "aborted";
  }
  writers.stdout(`Run destructive command '${label}'? [y/N] `);
  const answer = (await readAllStdin()).trim().toLowerCase();
  return answer === "y" || answer === "yes" ? "proceed" : "aborted";
};

const mapClientErrorExit = (error: McpClientError): ExitCode => {
  if (error.kind === "http") {
    if (error.httpStatus === 401) {
      return EXIT_CODES.auth;
    }
    if (error.httpStatus === 404) {
      return EXIT_CODES.notFound;
    }
    return EXIT_CODES.server;
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

const parsePayload = (result: CallToolResult): unknown => {
  const text = result.content.at(0)?.text ?? "";
  const parsed = Result.try((): unknown => JSON.parse(text));
  return Result.isOk(parsed) ? parsed.value : undefined;
};

/**
 * Map a tool `isError` result to an exit class (spec 051 S4). A feature-disabled
 * failure is exit 5 only when the server tags the error payload with a known
 * machine code; a plain-text error (today's server) has no code and falls to
 * exit 4. Text is never pattern-matched (it is locale-dependent server output).
 */
const classifyToolError = (payload: unknown): ExitCode => {
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

const readOutputFormat = (flags: LeafFlags, context: Context): OutputFormat => {
  const output = flags[RESERVED_FLAG_KEYS.output];
  return selectFormat({
    flags: {
      output: output === "json" || output === "table" ? output : undefined,
      json: flags[RESERVED_FLAG_KEYS.json] === true,
      table: flags[RESERVED_FLAG_KEYS.table] === true,
    },
    isTTY: context.process.stdout.isTTY,
  });
};

type AllOutcome = {
  payload: unknown;
  truncated: boolean;
  lastCursor: string | null;
  count: number;
};

/** Follow `nextCursor` under `--all`, concatenating items/text within ceilings. */
const followAll = async ({
  spec,
  baseArgs,
  serverUrl,
  token,
}: {
  spec: LeafCommandSpec;
  baseArgs: Record<string, unknown>;
  serverUrl: string;
  token: string;
}): Promise<Result<AllOutcome, McpClientError>> => {
  const items: unknown[] = [];
  let text = "";
  let firstPayload: Record<string, unknown> = {};
  let cursor: string | null = null;
  let pages = 0;
  let bytes = 0;
  let truncated = false;

  do {
    const args = { ...baseArgs, ...(cursor === null ? {} : { cursor }) };
    // eslint-disable-next-line no-await-in-loop -- each page's cursor comes from the previous response
    const call = await callTool({
      serverUrl,
      token,
      name: spec.toolName,
      args,
    });
    if (Result.isError(call)) {
      return call;
    }
    const payload = parsePayload(call.value);
    if (pages === 0 && isRecord(payload)) {
      firstPayload = payload;
    }
    pages += 1;

    if (spec.windowedText) {
      const chunk = stringField(payload, "text") ?? "";
      bytes += Buffer.byteLength(chunk);
      text += chunk;
    } else if (spec.itemsKey !== undefined) {
      const pageItems = arrayField(payload, spec.itemsKey);
      bytes += Buffer.byteLength(JSON.stringify(pageItems));
      items.push(...pageItems);
    }

    cursor = stringField(payload, "nextCursor");

    if (
      pages >= MAX_ALL_PAGES ||
      items.length >= MAX_ALL_ITEMS ||
      bytes >= MAX_ALL_BYTES
    ) {
      truncated = cursor !== null;
      break;
    }
  } while (cursor !== null);

  const mergedPayload = spec.windowedText
    ? { text, nextCursor: null }
    : { ...firstPayload, [spec.itemsKey ?? "items"]: items, nextCursor: null };

  return Result.ok({
    payload: mergedPayload,
    truncated,
    lastCursor: cursor,
    count: spec.windowedText ? Buffer.byteLength(text) : items.length,
  });
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
    writers.stderr(`${result.content.at(0)?.text ?? "Tool error"}\n`);
    setExit(context, classifyToolError(parsePayload(result)));
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

  const inputRaw = flags[RESERVED_FLAG_KEYS.input];
  let args: Record<string, unknown>;
  if (typeof inputRaw === "string") {
    const conflicting = spec.flags.some(
      (flagSpec) => flags[flagKey(flagSpec)] !== undefined,
    );
    if (conflicting) {
      writers.stderr("--input is exclusive with per-tool value flags.\n");
      setExit(context, EXIT_CODES.validation);
      return;
    }
    const parsed = await buildArgsFromInput({ inputRaw, spec, writers });
    if (parsed === undefined) {
      setExit(context, EXIT_CODES.validation);
      return;
    }
    args = parsed;
  } else {
    const built = await buildArgsFromFlags(spec, flags);
    if (!built.ok) {
      writers.stderr(`${built.message}\n`);
      setExit(context, EXIT_CODES.validation);
      return;
    }
    args = built.args;
  }

  if (spec.discriminatorInject !== undefined) {
    args = { ...args, ...spec.discriminatorInject };
  }

  // Client-side scope precheck (spec S3): fail before any server call.
  if (spec.scope !== undefined && !scopeGranted({ token, scope: spec.scope })) {
    writers.stderr(
      `Missing scope stella:${spec.scope}. Re-run 'stella auth login' to grant stella:${spec.scope}.\n`,
    );
    setExit(context, EXIT_CODES.auth);
    return;
  }

  if (spec.destructive) {
    const outcome = await confirmDestructive({
      context,
      flags,
      writers,
      label: spec.commandPath.join(" "),
    });
    if (outcome === "aborted") {
      setExit(context, EXIT_CODES.aborted);
      return;
    }
  }

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
  const cursorFlag = flags[RESERVED_FLAG_KEYS.cursor];
  const limitFlag = flags[RESERVED_FLAG_KEYS.limit];
  if (!allActive && typeof cursorFlag === "string") {
    args["cursor"] = cursorFlag;
  }
  if (typeof limitFlag === "string" && /^-?\d+$/u.test(limitFlag.trim())) {
    args["limit"] = Number.parseInt(limitFlag.trim(), 10);
  }

  if (allActive) {
    const outcome = await followAll({ spec, baseArgs: args, serverUrl, token });
    if (Result.isError(outcome)) {
      writers.stderr(`${outcome.error.message}\n`);
      setExit(context, mapClientErrorExit(outcome.error));
      return;
    }
    const plan = buildRenderPlan({
      payload: outcome.value.payload,
      itemsKey: spec.itemsKey,
      windowedText: spec.windowedText,
      singleReadActive: false,
      columns: undefined,
    });
    renderResult({ plan, format, writers, allActive: true });
    if (outcome.value.truncated) {
      writers.stderr(
        `--all truncated at ${outcome.value.count} items/pages; resume with --cursor ${outcome.value.lastCursor}\n`,
      );
    }
    return;
  }

  const call = await callTool({ serverUrl, token, name: spec.toolName, args });
  if (Result.isError(call)) {
    writers.stderr(`${call.error.message}\n`);
    setExit(context, mapClientErrorExit(call.error));
    return;
  }
  renderCallResult({ context, spec, result: call.value, format, writers });
};
