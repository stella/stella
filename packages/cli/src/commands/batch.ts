import { buildCommand, type Command } from "@stricli/core";
import {
  panic,
  Result,
  TaggedError,
  type TaggedErrorClass,
} from "better-result";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { Temporal } from "temporal-polyfill/full";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";

import { createCapabilityBulkHook } from "../batch/bulk.js";
import {
  type BatchCommand,
  type BatchItem,
  type BatchResponse,
  DEFAULT_BATCH_CONCURRENCY,
  MAX_BATCH_CONCURRENCY,
  runBatch,
} from "../batch/runner.js";
import { CliCommandError } from "../cli-exit-code.js";
import type { Context } from "../context.js";
import { MCP_CAPABILITY_EXECUTORS } from "../generated/mcp-contract.js";
import { type BatchToolCall, withBatchToolClient } from "../mcp-client.js";
import { EXIT_CODES } from "../mcp-constants.js";
import { buildCommonFlags, type CommonFlagValues } from "../output-flags.js";
import type { CapabilityLeafSpec, RouteNode } from "../route-types.js";
import {
  scopePreflightFailure,
  specHasConfirmGate,
} from "../run-leaf-command.js";
import { sha256Hex } from "../sha256.js";

type BatchFlags = CommonFlagValues & {
  concurrency: string | undefined;
  resume: string | undefined;
  dryRun: boolean | undefined;
  yes: boolean | undefined;
  noInput: boolean | undefined;
};

const MAX_BATCH_SOURCE_BYTES = 64 * 1024 * 1024;

const BatchSourceErrorBase: TaggedErrorClass<"BatchSourceError"> =
  TaggedError("BatchSourceError");
class BatchSourceError extends BatchSourceErrorBase<{ message: string }> {}

const readBatchSource = async (
  stream: Readable,
): Promise<Result<string, BatchSourceError>> => {
  const read = await Result.tryPromise(async () => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      const value: unknown = chunk;
      if (!Buffer.isBuffer(value)) {
        return panic("Batch input stream must contain bytes");
      }
      bytes += value.byteLength;
      if (bytes > MAX_BATCH_SOURCE_BYTES) {
        stream.destroy();
        return Result.err(
          new BatchSourceError({
            message: "Batch input exceeds the 64 MiB limit",
          }),
        );
      }
      chunks.push(value);
    }
    return Result.ok(Buffer.concat(chunks).toString("utf-8"));
  });
  return Result.isError(read)
    ? Result.err(
        new BatchSourceError({
          message: "Could not read batch input or resume file",
        }),
      )
    : read.value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const batchToolResponse = (
  response: Awaited<ReturnType<BatchToolCall>>,
  access: "read" | "write",
): BatchResponse => {
  if (Result.isError(response)) {
    if (response.error.httpStatus === 429) {
      return { status: "rate_limited", retryAfter: response.error.retryAfter };
    }
    if (
      access === "write" &&
      (response.error.kind === "transport" ||
        response.error.kind === "rpc" ||
        (response.error.httpStatus ?? 0) >= 500)
    ) {
      return {
        status: "unknown",
        reason:
          "The server outcome could not be confirmed. Check the item before submitting it again.",
      };
    }
    return {
      status: "error",
      error: { code: response.error.kind, message: response.error.message },
    };
  }
  const first = response.value.content.find((block) => block.type === "text");
  const parsed = Result.try((): unknown => JSON.parse(first?.text ?? "null"));
  if (Result.isError(parsed) || first === undefined) {
    return access === "write"
      ? {
          status: "unknown",
          reason:
            "The write returned an unreadable result. Check the item before submitting it again.",
        }
      : {
          status: "error",
          error: {
            code: "invalid_response",
            message: "Tool returned invalid JSON",
          },
        };
  }
  const payload = parsed.value;
  if (response.value.isError === true) {
    const error = isRecord(payload) ? (payload["error"] ?? payload) : payload;
    if (isRecord(error) && error["code"] === "rate_limited") {
      return {
        status: "rate_limited",
        retryAfter:
          typeof error["retryAfterMs"] === "number"
            ? String(error["retryAfterMs"] / 1000)
            : undefined,
      };
    }
    if (
      access === "write" &&
      isRecord(error) &&
      error["code"] === "internal_error"
    ) {
      return {
        status: "unknown",
        reason:
          "The server reported an internal failure. Check the item before submitting it again.",
      };
    }
    return { status: "error", error };
  }
  return {
    status: "ok",
    result:
      isRecord(payload) && "result" in payload ? payload["result"] : payload,
  };
};

type ResolveBatchCommandOptions = {
  tree: RouteNode;
  command: string;
  call: BatchToolCall;
  token: string | undefined;
  yes: boolean;
};

const capabilityCall = async ({
  spec,
  input,
  items,
  call,
  token,
  yes,
}: {
  spec: CapabilityLeafSpec;
  input: Record<string, unknown>;
  items: readonly BatchItem[];
  call: BatchToolCall;
  token: string | undefined;
  yes: boolean;
}): Promise<BatchResponse> => {
  const refusal = checkExecution({ spec, token, yes });
  if (refusal !== undefined) {
    return refusal;
  }
  const first = items.at(0);
  const key =
    items.length === 1
      ? first?.idempotencyKey
      : `stella-batch-${sha256Hex(JSON.stringify(items.map((item) => item.idempotencyKey)))}`;
  return batchToolResponse(
    await call({
      name: MCP_CAPABILITY_EXECUTORS[spec.access],
      args: {
        capability: spec.capabilityId,
        input,
        ...(yes ? { confirm: true } : {}),
      },
      ...(spec.access === "write" &&
      spec.idempotency?.type === "replay" &&
      key !== undefined
        ? { idempotencyKey: key }
        : {}),
      ...(spec.requestTimeoutMs === undefined
        ? {}
        : { timeoutMs: spec.requestTimeoutMs }),
    }),
    spec.access,
  );
};

const checkExecution = ({
  spec,
  token,
  yes,
}: {
  spec: {
    scope?: CapabilityLeafSpec["scope"];
    additionalScopes?: CapabilityLeafSpec["additionalScopes"];
    destructive: boolean;
    confirmation?: "required";
  };
  token: string | undefined;
  yes: boolean;
}): BatchResponse | undefined => {
  if (token === undefined) {
    return {
      status: "error",
      error: {
        code: "not_authenticated",
        message: "Run 'stella auth login' to authenticate",
      },
    };
  }
  const scope = scopePreflightFailure({
    token,
    scope: spec.scope,
    additionalScopes: spec.additionalScopes,
  });
  if (scope !== undefined) {
    return {
      status: "error",
      error: {
        code: "missing_scope",
        message: `Run '${scope.loginCommand}' to grant stella:${scope.missingScope}`,
      },
    };
  }
  if ((spec.destructive || spec.confirmation === "required") && !yes) {
    return {
      status: "error",
      error: {
        code: "confirmation_required",
        message: "Pass --yes to confirm this operation",
      },
    };
  }
  return undefined;
};

export const resolveBatchCommand = ({
  tree,
  command,
  call,
  token,
  yes,
}: ResolveBatchCommandOptions): BatchCommand | undefined => {
  let node = tree;
  for (const part of command.trim().split(/\s+/u)) {
    if (node.kind !== "route") {
      return undefined;
    }
    const next = node.children[part];
    if (next === undefined) {
      return undefined;
    }
    node = next;
  }
  switch (node.kind) {
    case "route":
      return undefined;
    case "capability-leaf": {
      const spec = node.spec;
      const bulk = createCapabilityBulkHook({
        spec,
        tree,
        invoke: async (target, input, items) =>
          capabilityCall({ spec: target, input, items, call, token, yes }),
      });
      return {
        access: spec.access,
        inputSchema: spec.inputSchema,
        execute: async (item) =>
          capabilityCall({
            spec,
            input: item.input,
            items: [item],
            call,
            token,
            yes,
          }),
        ...(bulk === undefined ? {} : { bulk }),
      };
    }
    case "leaf": {
      const spec = node.spec;
      const access = spec.readOnlyHint === true ? "read" : "write";
      const schema = { ...spec.inputSchema };
      if (
        Array.isArray(schema["required"]) &&
        spec.discriminatorInject !== undefined
      ) {
        schema["required"] = schema["required"].filter(
          (key) =>
            typeof key !== "string" ||
            spec.discriminatorInject?.[key] === undefined,
        );
      }
      return {
        access,
        inputSchema: schema,
        execute: async (item) => {
          const refusal = checkExecution({ spec, token, yes });
          if (refusal !== undefined) {
            return refusal;
          }
          return batchToolResponse(
            await call({
              name: spec.toolName,
              args: {
                ...item.input,
                ...spec.discriminatorInject,
                ...(yes &&
                (spec.destructive || spec.confirmPassthrough === true) &&
                specHasConfirmGate(spec)
                  ? { confirm: true }
                  : {}),
              },
              ...(spec.requestTimeoutMs === undefined
                ? {}
                : { timeoutMs: spec.requestTimeoutMs }),
            }),
            access,
          );
        },
      };
    }
    default: {
      node satisfies never;
      return panic("Unknown CLI route kind");
    }
  }
};

const parseString = (value: string): string => value;

export const buildBatchCommand = (tree: RouteNode): Command<Context> =>
  buildCommand<BatchFlags, [string], Context>({
    docs: {
      brief: "Run JSONL operations with bounded concurrency",
      fullDescription:
        "Read operations from a file or - for stdin (64 MiB maximum per input or resume file). Each line is {command, input, id?}, using the command's --input schema. Results are JSONL in input order. --resume skips matching successful results and lists unknown outcomes for reconciliation. --dry-run validates locally without server requests. Destructive operations require --yes.",
    },
    parameters: {
      flags: {
        ...buildCommonFlags(),
        concurrency: {
          kind: "parsed",
          parse: parseString,
          optional: true,
          brief: `Concurrent requests (default ${DEFAULT_BATCH_CONCURRENCY}, maximum ${MAX_BATCH_CONCURRENCY})`,
        },
        resume: {
          kind: "parsed",
          parse: parseString,
          optional: true,
          brief: "Previous results JSONL file",
        },
        dryRun: {
          kind: "boolean",
          optional: true,
          brief: "Validate every line without server requests",
        },
        yes: {
          kind: "boolean",
          optional: true,
          brief: "Confirm destructive operations",
        },
        noInput: {
          kind: "boolean",
          optional: true,
          brief: "Never prompt (batch never prompts)",
        },
      },
      positional: {
        kind: "tuple",
        parameters: [
          {
            brief: "Operations JSONL file, or - for stdin",
            parse: parseString,
          },
        ],
      },
    },
    func: async function func(this: Context, flags, file) {
      if (
        flags.table === true ||
        (flags.output !== undefined &&
          flags.output !== "jsonl" &&
          flags.output !== "json")
      ) {
        return new CliCommandError(
          "Batch results use JSONL; pass --output jsonl",
          EXIT_CODES.validation,
        );
      }
      const parsedConcurrency =
        flags.concurrency === undefined
          ? Result.ok(DEFAULT_BATCH_CONCURRENCY)
          : parseIntegerToken(flags.concurrency, {
              sign: "unsigned",
              min: 1,
              max: MAX_BATCH_CONCURRENCY,
            });
      if (Result.isError(parsedConcurrency)) {
        return new CliCommandError(
          `--concurrency must be an integer from 1 to ${MAX_BATCH_CONCURRENCY}`,
          EXIT_CODES.validation,
        );
      }
      const source = await readBatchSource(
        file === "-" ? this.process.stdin : createReadStream(file),
      );
      if (Result.isError(source)) {
        return new CliCommandError(source.error.message, EXIT_CODES.validation);
      }
      const resume =
        flags.resume === undefined
          ? Result.ok("")
          : await readBatchSource(createReadStream(flags.resume));
      if (Result.isError(resume)) {
        return new CliCommandError(resume.error.message, EXIT_CODES.validation);
      }
      const run = async (call: BatchToolCall) =>
        await runBatch({
          source: source.value,
          resume: resume.value,
          concurrency: parsedConcurrency.value,
          dryRun: flags.dryRun === true,
          resolve: (command) =>
            resolveBatchCommand({
              tree,
              command,
              call,
              token: this.token,
              yes: flags.yes === true,
            }),
          now: () => Temporal.Now.instant().epochMilliseconds,
          sleep: async (ms) => {
            await delay(ms);
          },
          emit: (entry) => {
            this.process.stdout.write(`${JSON.stringify(entry)}\n`);
          },
        });
      if (flags.dryRun === true) {
        const result = await run(
          async () => await Promise.resolve(Result.ok({ content: [] })),
        );
        if (Result.isError(result)) {
          return new CliCommandError(
            result.error.message,
            EXIT_CODES.validation,
          );
        }
        if (
          result.value.some(
            (entry) => entry.status === "error" || entry.status === "unknown",
          )
        ) {
          this.process.exitCode = EXIT_CODES.validation;
        }
        return undefined;
      }
      if (this.serverUrl === undefined || this.token === undefined) {
        return new CliCommandError(
          "Not signed in. Run 'stella auth login' to authenticate.",
          EXIT_CODES.auth,
        );
      }
      const session = await withBatchToolClient({
        serverUrl: this.serverUrl,
        token: this.token,
        operation: run,
      });
      if (Result.isError(session)) {
        return new CliCommandError(session.error.message, EXIT_CODES.server);
      }
      if (Result.isError(session.value)) {
        return new CliCommandError(
          session.value.error.message,
          EXIT_CODES.validation,
        );
      }
      if (
        session.value.value.some(
          (entry) => entry.status === "error" || entry.status === "unknown",
        )
      ) {
        this.process.exitCode = EXIT_CODES.server;
      }
      return undefined;
    },
  });
