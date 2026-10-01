/**
 * The deployment's System One client, built from the environment on first
 * use. Split from the transport so the transport stays importable without
 * evaluating `env`, and so a caller can ask "is this configured?" without
 * constructing anything.
 */

import { Result } from "better-result";

import { env } from "@/api/env";
import {
  assertManagedProviderAvailable,
  managedProviderUnavailable,
} from "@/api/lib/provider-data-policy";
import {
  createSystemOneClient,
  DEFAULT_SYSTEM_ONE_MODEL,
  SystemOneError,
} from "@/api/lib/workflow/decisions/system-one";
import type { SystemOneClient } from "@/api/lib/workflow/decisions/system-one";

let client: SystemOneClient | undefined;

/** Null when `TYPESAFE_API_KEY` is unset: every System One path is then skipped. */
export const getSystemOneClient = (): SystemOneClient | null => {
  if (env.TYPESAFE_API_KEY === undefined) {
    return null;
  }
  const policy = Result.try({
    try: () => assertManagedProviderAvailable("typesafe"),
    catch: (cause) =>
      new SystemOneError({
        kind: "invalid_request",
        status: 503,
        message: managedProviderUnavailable("typesafe").message,
        cause,
      }),
  });
  if (Result.isError(policy)) {
    return {
      model: env.TYPESAFE_MODEL ?? DEFAULT_SYSTEM_ONE_MODEL,
      ask: async () => Result.err(policy.error),
    };
  }
  if (client !== undefined) {
    return client;
  }
  client = createSystemOneClient({
    apiKey: env.TYPESAFE_API_KEY,
    model: env.TYPESAFE_MODEL,
  });
  return client;
};
