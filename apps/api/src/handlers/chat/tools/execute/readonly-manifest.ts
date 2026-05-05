import { toJsonSchema } from "@valibot/to-json-schema";
import type { JsonSchema } from "@valibot/to-json-schema";
import { Result } from "better-result";
import * as v from "valibot";

import type { ExecuteToolContract } from "@/api/handlers/chat/tools/execute/execute-tool-function";
import type { StellaAIOutput } from "@/api/handlers/chat/tools/execute/pagination";
import { SANDBOX_READ_GLOBAL } from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox-prelude";
import { ChatToolValidationError } from "@/api/lib/errors/tagged-errors";
import { jsonSchemaToAsyncFnType } from "@/api/lib/json-schema/json-schema-to-type";

type ReadonlyFunctionOutputSchema = v.GenericSchema<
  unknown,
  StellaAIOutput<unknown>
>;

type CreateFunctionSchemaProps = {
  description: string;
  inputSchema: v.GenericSchema;
  outputSchema: ReadonlyFunctionOutputSchema;
};

const createFunctionSchema = ({
  description,
  inputSchema,
  outputSchema,
}: CreateFunctionSchemaProps) =>
  v.pipe(
    v.function(),
    v.description(description),
    v.args(v.tuple([inputSchema])),
    v.returnsAsync(outputSchema),
  );

type CreateReadonlyFunctionContractProps<
  TName extends string,
  TInputSchema extends v.GenericSchema,
  TOutputSchema extends ReadonlyFunctionOutputSchema,
> = {
  description: string;
  input: TInputSchema;
  name: TName;
  output: TOutputSchema;
};

export const createReadonlyFunctionContract = <
  TName extends string,
  TInputSchema extends v.GenericSchema,
  TOutputSchema extends ReadonlyFunctionOutputSchema,
>({
  description,
  input,
  name,
  output,
}: CreateReadonlyFunctionContractProps<TName, TInputSchema, TOutputSchema>) =>
  ({
    input,
    name,
    output,
    schema: createFunctionSchema({
      description,
      inputSchema: input,
      outputSchema: output,
    }),
  }) as const satisfies ExecuteToolContract<TName, TInputSchema, TOutputSchema>;

export type ReadonlyFunctionContract = ExecuteToolContract<
  string,
  v.GenericSchema,
  ReadonlyFunctionOutputSchema
>;

export type ReadonlyFunctionManifest = {
  description: string;
  inputSchema: JsonSchema;
  name: string;
  outputSchema: JsonSchema;
};

const toManifestSchema = (
  schema: v.GenericSchema,
  typeMode: "input" | "output",
): Result<JsonSchema, ChatToolValidationError> =>
  Result.try({
    try: () =>
      toJsonSchema(schema, {
        errorMode: "throw",
        target: "draft-07",
        typeMode,
      }),
    catch: (cause) =>
      new ChatToolValidationError({
        message:
          typeMode === "input"
            ? "Failed to convert input schema to JSON Schema."
            : "Failed to convert output schema to JSON Schema.",
        cause,
      }),
  });

type BuildReadonlyFunctionManifestEntryProps = {
  contract: ReadonlyFunctionContract;
};

const buildReadonlyFunctionManifestEntry = ({
  contract,
}: BuildReadonlyFunctionManifestEntryProps): Result<
  ReadonlyFunctionManifest,
  ChatToolValidationError
> =>
  Result.gen(function* () {
    const inputSchema = yield* toManifestSchema(contract.input, "input");
    const outputSchema = yield* toManifestSchema(contract.output, "output");

    return Result.ok({
      description: v.getDescription(contract.schema) ?? "",
      inputSchema,
      name: contract.name,
      outputSchema,
    });
  });

export const buildReadonlyFunctionManifest = (
  contracts: readonly ReadonlyFunctionContract[],
): Result<ReadonlyFunctionManifest[], ChatToolValidationError> =>
  Result.gen(function* () {
    const manifest: ReadonlyFunctionManifest[] = [];

    for (const contract of contracts) {
      manifest.push(
        yield* buildReadonlyFunctionManifestEntry({
          contract,
        }),
      );
    }

    return Result.ok(manifest);
  });

type FindReadonlyFunctionManifestEntryProps = {
  contracts: readonly ReadonlyFunctionContract[];
  name: string;
};

export const findReadonlyFunctionManifestEntry = ({
  contracts,
  name,
}: FindReadonlyFunctionManifestEntryProps): Result<
  ReadonlyFunctionManifest | undefined,
  ChatToolValidationError
> =>
  buildReadonlyFunctionManifest(contracts).map((manifest) =>
    manifest.find((entry) => entry.name === name),
  );

export const buildReadonlyFunctionTypeDeclarations = (
  contracts: readonly ReadonlyFunctionContract[],
): Result<string, ChatToolValidationError> =>
  buildReadonlyFunctionManifest(contracts).map((manifest) => {
    const signatures = manifest.map((entry) =>
      jsonSchemaToAsyncFnType({
        name: entry.name,
        inputSchema: entry.inputSchema,
        outputSchema: entry.outputSchema,
      }),
    );

    return [
      "declare global {",
      `  namespace ${SANDBOX_READ_GLOBAL} {`,
      ...signatures.map((signature) => `    ${signature};`),
      "  }",
      "}",
    ].join("\n");
  });
