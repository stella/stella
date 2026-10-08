import { TaggedError } from "better-result";
import * as v from "valibot";

import { providerDiagnosticSchema } from "@stll/api-contract/provider-setup";
import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";

import { APIError } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";

export class ProviderDiagnosticError extends TaggedError(
  "ProviderDiagnosticError",
)<{
  message: string;
  diagnostic: ProviderDiagnostic;
}> {}

/** Parse only the explicit provider diagnostic envelope, never arbitrary error text. */
export const parseProviderDiagnostic = (value: unknown) => {
  const parsed = v.safeParse(providerDiagnosticSchema, value);
  if (!parsed.success) {
    throw new ClientOperationError({
      action: "parse-provider-diagnostic",
      message: "Invalid provider diagnostic response",
    });
  }
  return parsed.output;
};

export const providerDiagnosticFromThrown = (
  error: unknown,
): ProviderDiagnostic | undefined => {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (ProviderDiagnosticError.is(current)) {
      return current.diagnostic;
    }
    if (APIError.is(current) && current.providerDiagnostic !== undefined) {
      return current.providerDiagnostic;
    }
    seen.add(current);
    current = current.cause;
  }
  return undefined;
};

export const withProviderDiagnostic = (
  error: Error,
  diagnostic: ProviderDiagnostic | undefined,
) => {
  if (
    diagnostic === undefined ||
    providerDiagnosticFromThrown(error) !== undefined
  ) {
    return error;
  }
  return new ProviderDiagnosticError({ message: error.message, diagnostic });
};
