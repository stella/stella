/**
 * The deployment's System One client, built from the environment on first
 * use. Split from the transport so the transport stays importable without
 * evaluating `env`, and so a caller can ask "is this configured?" without
 * constructing anything.
 */

import { env } from "@/api/env";
import { createSystemOneClient } from "@/api/lib/workflow/decisions/system-one";
import type { SystemOneClient } from "@/api/lib/workflow/decisions/system-one";

let client: SystemOneClient | undefined;

/** Null when `TYPESAFE_API_KEY` is unset: every System One path is then skipped. */
export const getSystemOneClient = (): SystemOneClient | null => {
  if (env.TYPESAFE_API_KEY === undefined) {
    return null;
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
