// The executor for generated capability leaves (spec 049 Phase 3). Unlike the
// curated executor it calls the ONE generic `invoke_capability` tool with
// `{ capability, input: { body?, params?, query? }, validateOnly?, confirm? }`,
// mapping each flag back to the input part its schema declared. It shares the
// curated executor's helpers (confirm gates, scope precheck, `--all` follow,
// output contract) so the output/behavior contract stays identical CLI-wide.

import { Result } from "better-result";
import { readFile } from "node:fs/promises";

import type { Context } from "./context.js";
import { validateAgainstSchema } from "./json-schema-validate.js";
import { callTool, type CallToolResult } from "./mcp-client.js";
import { EXIT_CODES } from "./mcp-constants.js";
import {
  buildRenderPlan,
  renderResult,
  type OutputFormat,
  type Writers,
} from "./output.js";
import type { CapabilityLeafSpec } from "./route-types.js";
import {
  approvalReRunHint,
  coerceFlagValue,
  confirmDestructive,
  errorEnvelope,
  flagKey,
  mapClientErrorExit,
  parsePayload,
  readAllStdin,
  readOutputFormat,
  readRequestReceipt,
  renderToolError,
  requestIdLine,
  RESERVED_FLAG_KEYS,
  reservedFlagUsageError,
  scopeGranted,
  setExit,
  setPath,
  streamOrRenderAllPages,
  writersFor,
} from "./run-leaf-command.js";

/** The generic capability tool every capability leaf dispatches to. */
const INVOKE_TOOL = "invoke_capability";

type LeafFlags = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type InputResult =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; message: string };

/** Build the `{ body?, params?, query? }` input object from parsed value flags. */
const buildInputFromFlags = async (
  spec: CapabilityLeafSpec,
  flags: LeafFlags,
): Promise<InputResult> => {
  const input: Record<string, unknown> = {};
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
    setPath(input, `${flagSpec.part}.${flagSpec.partPath}`, coerced.value);
  }
  for (const flagSpec of spec.flags) {
    if (flagSpec.required && flags[flagKey(flagSpec)] === undefined) {
      return { ok: false, message: `missing required flag ${flagSpec.flag}` };
    }
  }
  return { ok: true, input };
};

/** Resolve `--input` (`-` stdin / `@file` / literal) to the parsed input object. */
const buildInputFromRaw = async ({
  inputRaw,
  spec,
  writers,
}: {
  inputRaw: string;
  spec: CapabilityLeafSpec;
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
  // Truncated entries carry no snapshot schema: skip client validation and let
  // the server validate against the live handler schema.
  if (!spec.schemaTruncated && spec.inputSchema !== undefined) {
    const validation = validateAgainstSchema(spec.inputSchema, parsed.value);
    if (!validation.valid) {
      writers.stderr(
        `--input invalid at ${validation.path}: ${validation.message}\n`,
      );
      return undefined;
    }
  }
  return parsed.value;
};

/** A fresh copy of the invoke args with `cursor` set inside the pagination part. */
const withCursor = (
  base: Record<string, unknown>,
  part: string,
  cursor: string,
): Record<string, unknown> => {
  const input = isRecord(base["input"]) ? base["input"] : {};
  const partObj = isRecord(input[part]) ? input[part] : {};
  return {
    ...base,
    input: { ...input, [part]: { ...partObj, cursor } },
  };
};

const renderCapabilityResult = ({
  context,
  spec,
  result,
  format,
  writers,
}: {
  context: Context;
  spec: CapabilityLeafSpec;
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
  // A list-shaped capability (Page<T>) renders as a page/table; anything else
  // renders as a single object. `itemsKey` is set only for paginated leaves.
  const plan = buildRenderPlan({
    payload,
    itemsKey: spec.itemsKey,
    windowedText: false,
    singleReadActive: false,
    columns: undefined,
  });
  renderResult({ plan, format, writers, allActive: false });

  const hint = approvalReRunHint({
    isTTY: context.process.stdout.isTTY,
    payload,
  });
  if (hint !== null) {
    writers.stderr(`${hint}\n`);
  }

  // Surface the server's request-id receipt for a mutation only: a write is an
  // action an operator may need to reference, a read is not. The id rides the
  // success payload's `meta.requestId` (stdout stays pure result; the receipt
  // goes to stderr).
  if (spec.access === "write") {
    const requestId = readRequestReceipt(payload);
    if (requestId !== undefined) {
      writers.stderr(requestIdLine(requestId, context.process.stderr.isTTY));
    }
  }
};

type CapabilityRetryOptions = {
  args: Record<string, unknown>;
  call: CallToolResult;
  context: Context;
  flags: LeafFlags;
  format: OutputFormat;
  serverUrl: string;
  spec: CapabilityLeafSpec;
  token: string;
  writers: Writers;
};

/**
 * Confirm-passthrough prompt-and-retry: a call WITHOUT `confirm` that comes back
 * `confirmation_required` prompts (on a TTY, unless `--no-input`) and retries
 * once with `confirm: true`. Returns true when it fully handled the command. A
 * declined/refused prompt is terminal (one stderr `aborted` line, exit 7): the
 * original envelope is NOT rendered on top of the abort, matching the pre-call
 * destructive abort flow.
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
}: CapabilityRetryOptions): Promise<boolean> => {
  if (
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
    name: INVOKE_TOOL,
    args: { ...args, confirm: true },
  });
  if (Result.isError(retry)) {
    writers.stderr(`${retry.error.message}\n`);
    setExit(context, mapClientErrorExit(retry.error));
    return true;
  }
  renderCapabilityResult({
    context,
    spec,
    result: retry.value,
    format,
    writers,
  });
  return true;
};

/** Run one capability leaf end to end. Sets `process.exitCode` per spec S4. */
export const runCapabilityCommand = async ({
  context,
  flags,
  spec,
}: {
  context: Context;
  flags: LeafFlags;
  spec: CapabilityLeafSpec;
}): Promise<void> => {
  const writers = writersFor(context);

  const { serverUrl, token } = context;
  if (serverUrl === undefined || token === undefined) {
    writers.stderr("Not signed in. Run 'stella auth login' to authenticate.\n");
    setExit(context, EXIT_CODES.auth);
    return;
  }

  // Reserved flag VALUES fail loudly (exit 2) instead of being silently
  // dropped from the request (e.g. `--limit abc`), same as the curated executor.
  const reservedUsage = reservedFlagUsageError(flags);
  if (reservedUsage !== null) {
    writers.stderr(`${reservedUsage}\n`);
    setExit(context, EXIT_CODES.validation);
    return;
  }

  const inputRaw = flags[RESERVED_FLAG_KEYS.input];
  let input: Record<string, unknown>;
  if (typeof inputRaw === "string") {
    const conflicting = spec.flags.some(
      (flagSpec) => flags[flagKey(flagSpec)] !== undefined,
    );
    if (conflicting) {
      writers.stderr("--input is exclusive with per-capability value flags.\n");
      setExit(context, EXIT_CODES.validation);
      return;
    }
    const parsed = await buildInputFromRaw({ inputRaw, spec, writers });
    if (parsed === undefined) {
      setExit(context, EXIT_CODES.validation);
      return;
    }
    input = parsed;
  } else {
    const built = await buildInputFromFlags(spec, flags);
    if (!built.ok) {
      writers.stderr(`${built.message}\n`);
      setExit(context, EXIT_CODES.validation);
      return;
    }
    input = built.input;
  }

  // Client-side scope precheck (spec S3): fail before any server call.
  if (spec.scope !== undefined && !scopeGranted({ token, scope: spec.scope })) {
    writers.stderr(
      `Missing scope stella:${spec.scope}. Re-run 'stella auth login' to grant stella:${spec.scope}.\n`,
    );
    setExit(context, EXIT_CODES.auth);
    return;
  }

  const format = readOutputFormat(flags, context);
  const allActive = spec.paginated && flags[RESERVED_FLAG_KEYS.all] === true;
  const paginationPart = spec.paginationPart;

  // Reserved pagination flags map into the capability's pagination part
  // (`input.query.cursor` / `input.body.limit`, etc.). Values were validated
  // up front (`reservedFlagUsageError`), so a present `--limit` always parses.
  if (spec.paginated && paginationPart !== undefined) {
    const cursorFlag = flags[RESERVED_FLAG_KEYS.cursor];
    const limitFlag = flags[RESERVED_FLAG_KEYS.limit];
    if (!allActive && typeof cursorFlag === "string") {
      setPath(input, `${paginationPart}.cursor`, cursorFlag);
    }
    if (typeof limitFlag === "string") {
      setPath(
        input,
        `${paginationPart}.limit`,
        Number.parseInt(limitFlag.trim(), 10),
      );
    }
  }

  const toolArgs: Record<string, unknown> = {
    capability: spec.capabilityId,
    input,
  };
  if (flags[RESERVED_FLAG_KEYS.dryRun] === true) {
    toolArgs["validateOnly"] = true;
  }

  // Confirm gates. A known-destructive capability prompts up front; any
  // capability pre-approves the server's per-capability gate with --yes.
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
    toolArgs["confirm"] = true;
  } else if (flags[RESERVED_FLAG_KEYS.yes] === true) {
    toolArgs["confirm"] = true;
  }

  if (allActive && paginationPart !== undefined) {
    await streamOrRenderAllPages({
      context,
      writers,
      format,
      windowedText: false,
      itemsKey: spec.itemsKey,
      baseArgs: toolArgs,
      serverUrl,
      token,
      toolName: INVOKE_TOOL,
      cursorInto: (base, cursor) => withCursor(base, paginationPart, cursor),
    });
    return;
  }

  const call = await callTool({
    serverUrl,
    token,
    name: INVOKE_TOOL,
    args: toolArgs,
  });
  if (Result.isError(call)) {
    writers.stderr(`${call.error.message}\n`);
    setExit(context, mapClientErrorExit(call.error));
    return;
  }

  const retried = await maybeConfirmRetry({
    args: toolArgs,
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

  renderCapabilityResult({
    context,
    spec,
    result: call.value,
    format,
    writers,
  });
};
