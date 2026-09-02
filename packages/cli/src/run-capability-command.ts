// The executor for generated capability leaves (spec 049 Phase 3). Unlike the
// curated executor it calls the ONE generic `invoke_capability` tool with
// `{ capability, input: { body?, params?, query? }, validate_only?, confirm? }`,
// mapping each flag back to the input part its schema declared. It shares the
// curated executor's helpers (confirm gates, scope precheck, `--all` follow,
// output contract) so the output/behavior contract stays identical CLI-wide.

import { Result } from "better-result";

import type { Context } from "./context.js";
import { expandSchemaDefs } from "./expand-schema-defs.js";
import { validateAgainstSchema } from "./json-schema-validate.js";
import { callTool, type CallToolResult } from "./mcp-client.js";
import { EXIT_CODES } from "./mcp-constants.js";
import type { CapabilityLeafSpec } from "./route-types.js";
import {
  composeInputFromFlags,
  confirmDestructive,
  mapClientErrorExit,
  maybeConfirmAndRetry,
  parseInputObject,
  readOutputFormat,
  renderCommandResult,
  RESERVED_FLAG_KEYS,
  reservedFlagUsageError,
  scopePreflightFailure,
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

  // `--input` and value flags COMPOSE: the JSON is the base, then each explicit
  // flag overlays its own input path on top (flag wins). A required value flag
  // (e.g. --workspace) advertised on the usage line therefore stays usable
  // alongside a body passed through --input, instead of forcing the caller to
  // hand-relocate it into `params.workspaceId` in the JSON.
  const inputRaw = flags[RESERVED_FLAG_KEYS.input];
  const inputBase =
    typeof inputRaw === "string"
      ? await parseInputObject({ inputRaw, writers })
      : {};
  if (inputBase === undefined) {
    setExit(context, EXIT_CODES.validation);
    return;
  }
  const built = await composeInputFromFlags({
    base: inputBase,
    flagPath: (flagSpec) => `${flagSpec.part}.${flagSpec.partPath}`,
    flagSpecs: spec.flags,
    flags,
  });
  if (!built.ok) {
    writers.stderr(`${built.message}\n`);
    setExit(context, EXIT_CODES.validation);
    return;
  }
  const input = built.args;

  // Validate the COMPOSED input (JSON base + overlaid flags) against the snapshot
  // schema, only when `--input` supplied JSON. Flags-only requests keep relying on
  // the required-flag check plus server validation (unchanged surface). The
  // baked schema is `$defs`-compacted, so inline its refs first; expansion is
  // per-command and only on this path, never at startup.
  if (typeof inputRaw === "string") {
    const schema = expandSchemaDefs(spec.inputSchema);
    if (schema === null) {
      writers.stderr(
        `Cannot validate --input: the baked schema for ${spec.capabilityId} has unresolvable $defs references.\n`,
      );
      setExit(context, EXIT_CODES.validation);
      return;
    }
    const validation = validateAgainstSchema(schema, input);
    if (!validation.valid) {
      writers.stderr(
        `--input invalid at ${validation.path}: ${validation.message}\n`,
      );
      setExit(context, EXIT_CODES.validation);
      return;
    }
  }

  // Client-side scope precheck (spec S3): fail before any server call.
  const scopeFailure = scopePreflightFailure({
    additionalScopes: spec.additionalScopes,
    scope: spec.scope,
    token,
  });
  if (scopeFailure !== undefined) {
    writers.stderr(
      `Missing scope stella:${scopeFailure.missingScope}. Re-run '${scopeFailure.loginCommand}' to grant the complete scope set.\n`,
    );
    setExit(context, EXIT_CODES.auth);
    return;
  }

  const format = readOutputFormat(flags, context);
  const renderCall = (result: CallToolResult) => {
    renderCommandResult({
      context,
      format,
      itemsKey: spec.itemsKey,
      result,
      windowedText: false,
      writers,
      writeReceipt: spec.access === "write",
    });
  };
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
    toolArgs["validate_only"] = true;
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

  const retried = await maybeConfirmAndRetry({
    args: toolArgs,
    call: call.value,
    context,
    enabled: true,
    flags,
    label: spec.commandPath.join(" "),
    renderCall,
    serverUrl,
    timeoutMs: undefined,
    token,
    toolName: INVOKE_TOOL,
    writers,
  });
  if (retried) {
    return;
  }

  renderCall(call.value);
};
