import {
  panic,
  Result,
  TaggedError,
  type TaggedErrorClass,
} from "better-result";

import { parseDecimalToken } from "@stll/agent-input/numeric-token";
import {
  stableStringify,
  type StableStringifyInput,
} from "@stll/stable-stringify";

import { expandSchemaDefs } from "../expand-schema-defs.js";
import { validateAgainstSchema } from "../json-schema-validate.js";
import { sha256Hex } from "../sha256.js";

export const DEFAULT_BATCH_CONCURRENCY = 6;
export const MAX_BATCH_CONCURRENCY = 16;
const MAX_RATE_LIMIT_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 1000;

const BatchInputErrorBase: TaggedErrorClass<"BatchInputError"> =
  TaggedError("BatchInputError");
export class BatchInputError extends BatchInputErrorBase<{
  message: string;
}> {}

export type BatchItem = {
  id: string;
  line: number;
  command: string;
  input: Record<string, unknown>;
  idempotencyKey: string;
};

export type BatchResponse =
  | { status: "ok"; result: unknown }
  | { status: "error"; error: unknown }
  | { status: "unknown"; reason: string }
  | { status: "rate_limited"; retryAfter: string | undefined };

export type BatchResult =
  | { id: string; line: number; status: "ok"; result: unknown }
  | { id: string; line: number; status: "skipped"; result: unknown }
  | { id: string; line: number; status: "error"; error: unknown }
  | { id: string; line: number; status: "unknown"; reason: string };

export type BatchCommand = {
  access: "read" | "write";
  inputSchema: Record<string, unknown>;
  execute: (item: BatchItem) => Promise<BatchResponse>;
  bulk?: {
    maxItems: number;
    canGroup?: (previous: BatchItem, next: BatchItem) => boolean;
    execute: (items: readonly BatchItem[]) => Promise<BatchResponse[]>;
  };
};

export type RunBatchOptions = {
  source: string;
  concurrency?: number;
  resume?: string;
  dryRun?: boolean;
  resolve: (command: string) => BatchCommand | undefined;
  emit?: (result: BatchResult) => void;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonValue = (value: unknown): value is StableStringifyInput =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  (Array.isArray(value) && value.every(isJsonValue)) ||
  (isRecord(value) && Object.values(value).every(isJsonValue));

const isJsonRecord = (
  value: unknown,
): value is Record<string, StableStringifyInput> =>
  isRecord(value) && Object.values(value).every(isJsonValue);

const jsonLines = (source: string) => {
  const lines = source.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return source === "" ? [] : lines;
};

const readResume = (source: string) => {
  const completed = new Map<string, unknown>();
  const unresolved = new Map<string, string>();
  for (const [index, line] of jsonLines(source).entries()) {
    const parsed = Result.try((): unknown => JSON.parse(line));
    if (
      Result.isError(parsed) ||
      !isRecord(parsed.value) ||
      typeof parsed.value["id"] !== "string" ||
      !Number.isInteger(parsed.value["line"]) ||
      !["ok", "error", "skipped", "unknown"].includes(
        String(parsed.value["status"]),
      ) ||
      (parsed.value["status"] === "unknown" &&
        typeof parsed.value["reason"] !== "string")
    ) {
      return Result.err(
        new BatchInputError({
          message: `Invalid resume result at line ${index + 1}`,
        }),
      );
    }
    if (parsed.value["status"] === "ok") {
      completed.set(parsed.value["id"], parsed.value["result"]);
    } else if (
      parsed.value["status"] === "unknown" &&
      typeof parsed.value["reason"] === "string"
    ) {
      unresolved.set(parsed.value["id"], parsed.value["reason"]);
    }
  }
  return Result.ok({ completed, unresolved });
};

const retryDelay = (
  retryAfter: string | undefined,
  now: number,
  attempt: number,
) => {
  if (retryAfter !== undefined) {
    const seconds = parseDecimalToken(retryAfter, { sign: "unsigned", min: 0 });
    if (Result.isOk(seconds)) {
      return seconds.value * 1000;
    }
    // Retry-After carries the HTTP-date grammar, which Temporal does not parse.
    const date = new Date(retryAfter).getTime();
    if (Number.isFinite(date)) {
      return Math.max(0, date - now);
    }
  }
  return DEFAULT_RETRY_DELAY_MS * 2 ** attempt;
};

type Work = { item: BatchItem; command: BatchCommand };

const failedResponse = (
  { item, command }: Work,
  message: string,
): BatchResult => {
  switch (command.access) {
    case "write":
      return {
        id: item.id,
        line: item.line,
        status: "unknown",
        reason: message,
      };
    case "read":
      return {
        id: item.id,
        line: item.line,
        status: "error",
        error: { code: "transport_error", message },
      };
    default:
      command.access satisfies never;
      return panic("Unhandled batch command access");
  }
};

const groupWork = (work: readonly Work[]) => {
  const groups: Work[][] = [];
  for (const entry of work) {
    const previous = groups.at(-1);
    const last = previous?.at(-1);
    const maxItems = entry.command.bulk?.maxItems;
    if (
      previous !== undefined &&
      last !== undefined &&
      maxItems !== undefined &&
      Number.isInteger(maxItems) &&
      maxItems > 0 &&
      previous.length < maxItems &&
      last.item.command === entry.item.command &&
      last.item.line + 1 === entry.item.line &&
      (entry.command.bulk?.canGroup?.(last.item, entry.item) ?? true)
    ) {
      previous.push(entry);
    } else {
      groups.push([entry]);
    }
  }
  return groups;
};

type RunGroupsOptions = {
  groups: Work[][];
  concurrency: number;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  store: (result: BatchResult) => void;
  completed: ReadonlyMap<string, unknown>;
  unresolved: ReadonlyMap<string, string>;
};

const runGroups = async ({
  groups,
  concurrency,
  now,
  sleep,
  store,
  completed,
  unresolved,
}: RunGroupsOptions) => {
  let next = 0;
  let cooldownUntil = 0;
  const waitForCooldown = async () => {
    while (now() < cooldownUntil) {
      await sleep(cooldownUntil - now());
    }
  };
  const storePending = (result: BatchResult) => {
    if (!completed.has(result.id) && !unresolved.has(result.id)) {
      store(result);
    }
  };
  const execute = async (group: Work[]) => {
    if (group.every(({ item }) => completed.has(item.id))) {
      return;
    }
    if (group.some(({ item }) => unresolved.has(item.id))) {
      for (const { item } of group) {
        storePending({
          id: item.id,
          line: item.line,
          status: "unknown",
          reason:
            "The original bulk group contains an unresolved operation; reconcile it before retrying",
        });
      }
      return;
    }
    let pending = group;
    for (let attempt = 0; pending.length > 0; attempt += 1) {
      await waitForCooldown();
      const first = pending.at(0);
      if (first === undefined) {
        return;
      }
      const requestItems = pending;
      const call = await Result.tryPromise(async () => {
        if (requestItems.length > 1 && first.command.bulk !== undefined) {
          return first.command.bulk.execute(
            requestItems.map(({ item }) => item),
          );
        }
        return [await first.command.execute(first.item)];
      });
      if (Result.isError(call)) {
        for (const entry of pending) {
          storePending(
            failedResponse(
              entry,
              "Request outcome could not be confirmed; reconcile the operation before retrying",
            ),
          );
        }
        return;
      }
      if (call.value.length !== pending.length) {
        for (const entry of pending) {
          storePending(
            failedResponse(
              entry,
              "Bulk response did not confirm one outcome per item; reconcile the operation before retrying",
            ),
          );
        }
        return;
      }
      const retry: Work[] = [];
      for (const [index, response] of call.value.entries()) {
        const entry = pending.at(index);
        if (entry === undefined) {
          continue;
        }
        const { item } = entry;
        if (completed.has(item.id)) {
          if (
            response.status === "rate_limited" &&
            attempt < MAX_RATE_LIMIT_RETRIES
          ) {
            retry.push(entry);
          }
          continue;
        }
        switch (response.status) {
          case "ok":
            storePending({
              id: item.id,
              line: item.line,
              status: "ok",
              result: response.result,
            });
            break;
          case "error":
            storePending({
              id: item.id,
              line: item.line,
              status: "error",
              error: response.error,
            });
            break;
          case "unknown":
            storePending({
              id: item.id,
              line: item.line,
              status: "unknown",
              reason: response.reason,
            });
            break;
          case "rate_limited":
            cooldownUntil = Math.max(
              cooldownUntil,
              now() + retryDelay(response.retryAfter, now(), attempt),
            );
            if (attempt >= MAX_RATE_LIMIT_RETRIES) {
              storePending({
                id: item.id,
                line: item.line,
                status: "error",
                error: {
                  code: "rate_limited",
                  message: "Rate limit retry budget exhausted",
                },
              });
            } else {
              retry.push(entry);
            }
            break;
          default:
            response satisfies never;
            panic("Unhandled batch transport response");
        }
      }
      pending = retry;
    }
  };
  const worker = async () => {
    while (next < groups.length) {
      const group = groups.at(next);
      next += 1;
      if (group !== undefined) {
        await execute(group);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, groups.length) }, worker),
  );
};

const createOrderedResults = (emit: RunBatchOptions["emit"]) => {
  const results: (BatchResult | undefined)[] = [];
  let emitted = 0;
  const flush = () => {
    while (results[emitted] !== undefined) {
      const result = results[emitted];
      if (result === undefined) {
        break;
      }
      emit?.(result);
      emitted += 1;
    }
  };
  const store = (result: BatchResult) => {
    results[result.line - 1] = result;
    flush();
  };
  return { results, store, flush };
};

export const runBatch = async ({
  source,
  concurrency = DEFAULT_BATCH_CONCURRENCY,
  resume = "",
  dryRun = false,
  resolve,
  emit,
  now,
  sleep,
}: RunBatchOptions): Promise<Result<BatchResult[], BatchInputError>> => {
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_BATCH_CONCURRENCY
  ) {
    return Result.err(
      new BatchInputError({
        message: `Concurrency must be an integer between 1 and ${MAX_BATCH_CONCURRENCY}`,
      }),
    );
  }
  const completed = readResume(resume);
  if (Result.isError(completed)) {
    return completed;
  }
  const { results, store, flush } = createOrderedResults(emit);
  const work: Work[] = [];
  const ids = new Set<string>();
  for (const [index, text] of jsonLines(source).entries()) {
    const line = index + 1;
    const fallbackId = sha256Hex(`${line}:${text}`);
    const parsed = Result.try((): unknown => JSON.parse(text));
    if (Result.isError(parsed)) {
      results[index] = {
        id: fallbackId,
        line,
        status: "error",
        error: {
          code: "invalid_json",
          message: "Expected one JSON object per line",
        },
      };
      flush();
      continue;
    }
    const raw = parsed.value;
    if (
      !isRecord(raw) ||
      typeof raw["command"] !== "string" ||
      !isJsonRecord(raw["input"]) ||
      (raw["id"] !== undefined &&
        (typeof raw["id"] !== "string" || raw["id"].length === 0))
    ) {
      results[index] = {
        id: fallbackId,
        line,
        status: "error",
        error: {
          code: "invalid_operation",
          message:
            "Expected command, input object, and optional nonempty string id",
        },
      };
      flush();
      continue;
    }
    const commandPath = raw["command"].trim().split(/\s+/u).join(" ");
    const identity =
      typeof raw["id"] === "string"
        ? stableStringify({ id: raw["id"], command: commandPath })
        : stableStringify({ line, command: commandPath, input: raw["input"] });
    const idempotencyKey = `stella-batch-${sha256Hex(identity)}`;
    const id = typeof raw["id"] === "string" ? raw["id"] : idempotencyKey;
    if (ids.has(id)) {
      results[index] = {
        id,
        line,
        status: "error",
        error: {
          code: "duplicate_id",
          message: "Each operation must have a unique caller id",
        },
      };
      flush();
      continue;
    }
    ids.add(id);
    const command = resolve(commandPath);
    if (command === undefined) {
      results[index] = {
        id,
        line,
        status: "error",
        error: {
          code: "unknown_command",
          message: `Unknown command: ${commandPath}`,
        },
      };
      flush();
      continue;
    }
    const schema = expandSchemaDefs(command.inputSchema);
    if (schema === null) {
      results[index] = {
        id,
        line,
        status: "error",
        error: {
          code: "invalid_schema",
          message: "Command input schema could not be expanded",
        },
      };
      flush();
      continue;
    }
    const validation = validateAgainstSchema(schema, raw["input"]);
    if (!validation.valid) {
      results[index] = {
        id,
        line,
        status: "error",
        error: {
          code: "invalid_input",
          message: validation.message,
          path: validation.path,
        },
      };
      flush();
      continue;
    }
    if (completed.value.completed.has(id)) {
      store({
        id,
        line,
        status: "skipped",
        result: completed.value.completed.get(id),
      });
    } else if (completed.value.unresolved.has(id)) {
      store({
        id,
        line,
        status: "unknown",
        reason:
          completed.value.unresolved.get(id) ??
          panic("Unresolved batch receipt has no reason"),
      });
    } else if (dryRun) {
      store({
        id,
        line,
        status: "skipped",
        result: { validated: true, reason: "dry_run" },
      });
    }
    if (!dryRun) {
      if (
        !completed.value.completed.has(id) &&
        !completed.value.unresolved.has(id)
      ) {
        results[index] = undefined;
      }
      work.push({
        item: {
          id,
          line,
          command: commandPath,
          input: raw["input"],
          idempotencyKey,
        },
        command,
      });
    }
  }

  await runGroups({
    groups: groupWork(work),
    concurrency,
    now,
    sleep,
    store,
    completed: completed.value.completed,
    unresolved: completed.value.unresolved,
  });
  flush();
  return Result.ok(
    results.map(
      (result) => result ?? panic("Batch item completed without a result"),
    ),
  );
};
