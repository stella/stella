import {
  GetParameterCommand,
  type GetParameterCommandOutput,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { Result, TaggedError } from "better-result";

import { TimeoutError, withTimeout } from "@stll/concurrency/with-timeout";

const PARAMETER_READ_TIMEOUT_MS = 5000;

export class ParameterStoreError extends TaggedError("ParameterStoreError")<{
  message: string;
  reason: "not_found" | "access_denied" | "timeout" | "unavailable";
}> {}

let client: SSMClient | undefined;
const getClient = () => (client ??= new SSMClient({}));

type ReadParameterOptions = {
  name: string;
  decryption: "enabled" | "disabled";
  signal?: AbortSignal;
  client?: {
    send: (
      command: GetParameterCommand,
      options: { abortSignal: AbortSignal },
    ) => Promise<GetParameterCommandOutput>;
  };
};

/** Reads exactly one configured parameter; errors omit provider messages and values. */
export const readParameter = async ({
  name,
  decryption,
  signal,
  client: injectedClient,
}: ReadParameterOptions) => {
  const result = await Result.tryPromise({
    try: async () =>
      withTimeout(
        async (abortSignal) =>
          await (injectedClient ?? getClient()).send(
            new GetParameterCommand({
              Name: name,
              WithDecryption: decryption === "enabled",
            }),
            { abortSignal },
          ),
        {
          label: "parameter_store.read",
          signal,
          timeoutMs: PARAMETER_READ_TIMEOUT_MS,
        },
      ),
    catch: (error) => {
      if (
        TimeoutError.is(error) ||
        (error instanceof Error &&
          ["TimeoutError", "AbortError"].includes(error.name))
      ) {
        return new ParameterStoreError({
          message: "Parameter store read timed out",
          reason: "timeout",
        });
      }
      if (error instanceof Error) {
        switch (error.name) {
          case "ParameterNotFound":
          case "ParameterVersionNotFound":
            return new ParameterStoreError({
              message: "Parameter was not found",
              reason: "not_found",
            });
          case "AccessDenied":
          case "AccessDeniedException":
            return new ParameterStoreError({
              message: "Parameter store access was denied",
              reason: "access_denied",
            });
          default:
            break;
        }
      }
      return new ParameterStoreError({
        message: "Parameter store is unavailable",
        reason: "unavailable",
      });
    },
  });
  if (result.isErr()) {
    return result;
  }
  const parameter = result.value.Parameter;
  if (parameter?.Value === undefined || parameter.Version === undefined) {
    return Result.err(
      new ParameterStoreError({
        message: "Parameter store returned an incomplete value",
        reason: "unavailable",
      }),
    );
  }
  return Result.ok({ value: parameter.Value, version: parameter.Version });
};
