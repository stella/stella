import type { Err } from "better-result";
import { Panic, Result, UnhandledException } from "better-result";
import * as v from "valibot";

import type { SafeDbError } from "@/api/db";
import {
  ChatToolError,
  ChatToolValidationError,
  DatabaseError,
  DatabaseRlsError,
} from "@/api/lib/errors/tagged-errors";

export type ExecuteToolContract<
  TName extends string = string,
  TInputSchema extends v.GenericSchema = v.GenericSchema,
  TOutputSchema extends v.GenericSchema = v.GenericSchema,
> = {
  input: TInputSchema;
  name: TName;
  output: TOutputSchema;
  schema: v.GenericSchema;
};

export type ExecuteToolFunction<
  TInputSchema extends v.GenericSchema,
  TOutputSchema extends v.GenericSchema,
> = {
  execute: (
    props: ExecuteToolFunctionExecuteProps,
  ) => Promise<v.InferOutput<TOutputSchema>>;
  functionSchema: v.GenericSchema;
  inputSchema: TInputSchema;
  name: string;
  outputSchema: TOutputSchema;
};

export type ExecuteToolFunctionExecuteProps = {
  input: unknown;
  signal: AbortSignal;
};

type ExecuteToolError = ChatToolError | SafeDbError;

type ExecuteToolResult<TValue> = Result<TValue, ExecuteToolError>;

export type ExecuteToolHandler<
  TInputSchema extends v.GenericSchema,
  TOutputSchema extends v.GenericSchema,
> = (
  input: v.InferOutput<TInputSchema>,
  props: ExecuteToolHandlerProps,
) => AsyncGenerator<
  Err<never, ExecuteToolError>,
  ExecuteToolResult<v.InferOutput<TOutputSchema>>,
  unknown
>;

export type ExecuteToolHandlerProps = {
  signal: AbortSignal;
};

export const createToolFunction = <
  TName extends string,
  TInputSchema extends v.GenericSchema,
  TOutputSchema extends v.GenericSchema,
>(
  contract: ExecuteToolContract<TName, TInputSchema, TOutputSchema>,
  handler: ExecuteToolHandler<TInputSchema, TOutputSchema>,
): ExecuteToolFunction<TInputSchema, TOutputSchema> => ({
  execute: async ({ input: rawInput, signal }) => {
    signal.throwIfAborted();

    const parsedInput = parseToolValue({
      contractName: contract.name,
      phase: "input",
      schema: contract.input,
      value: rawInput,
    }).unwrap();

    signal.throwIfAborted();

    const handlerResult = await Result.gen(() =>
      handler(parsedInput, { signal }),
    )
      .catch((error: unknown) => Result.err(normalizeThrownError(error)))
      .then((result) => result.mapError(mapExecutionError));

    signal.throwIfAborted();

    return parseToolValue({
      contractName: contract.name,
      phase: "output",
      schema: contract.output,
      value: handlerResult.unwrap(),
    }).unwrap();
  },
  functionSchema: contract.schema,
  inputSchema: contract.input,
  name: contract.name,
  outputSchema: contract.output,
});

type ParseToolValueProps<TSchema extends v.GenericSchema> = {
  contractName: string;
  phase: "input" | "output";
  schema: TSchema;
  value: unknown;
};

const parseToolValue = <TSchema extends v.GenericSchema>({
  contractName,
  phase,
  schema,
  value,
}: ParseToolValueProps<TSchema>): Result<
  v.InferOutput<TSchema>,
  ChatToolValidationError
> => {
  const parsedValue = v.safeParse(schema, value);
  if (!parsedValue.success) {
    return Result.err(
      new ChatToolValidationError({
        message: `Invalid ${phase} for ${contractName}: ${v.summarize(parsedValue.issues)}`,
      }),
    );
  }

  return Result.ok(parsedValue.output);
};

const normalizeThrownError = (error: unknown): Panic | UnhandledException => {
  if (Panic.is(error)) {
    return error;
  }

  return new UnhandledException({ cause: error });
};

type ExecuteToolExecutionError = ExecuteToolError | Panic | UnhandledException;

const mapExecutionError = (error: ExecuteToolExecutionError) => {
  if (Panic.is(error)) {
    return error;
  }

  if (ChatToolError.is(error)) {
    return error;
  }

  if (DatabaseError.is(error)) {
    return new ChatToolError({
      message:
        "The tool could not load the requested data because a data operation failed.",
    });
  }

  if (DatabaseRlsError.is(error)) {
    return new ChatToolError({
      message:
        "The tool could not load the requested data because the data operation was rejected.",
    });
  }

  return new ChatToolError({
    message: "The tool failed while processing the request.",
  });
};
