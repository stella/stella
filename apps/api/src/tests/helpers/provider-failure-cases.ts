/**
 * Provider failures a handler has to name, with the answer each one owes.
 *
 * Shared because more than one endpoint maps the same `WorkflowIntegrationError`
 * cause through `aiHandlerError`. A per-file copy of this table agrees with the
 * mapping right up to the day one endpoint's copy is updated and the other's is
 * not, which is the divergence the mapping exists to prevent.
 *
 * The status and the copy are written out rather than read back from
 * `aiHandlerError`: a test that asks the mapping what the mapping does passes
 * whatever the mapping says.
 */

import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";

export type ProviderFailureCase = {
  /** Reads into the test name: "answers <name> with the status that names it". */
  name: string;
  /** The provider's own failure, in the shape an adapter surfaces it. */
  cause: unknown;
  status: number;
  message: string;
};

export const PROVIDER_FAILURE_CASES = [
  {
    name: "an exhausted quota",
    cause: Object.assign(new Error("Rate limit reached for requests"), {
      statusCode: 429,
    }),
    status: 429,
    message:
      "The AI provider's quota is exhausted. Try again shortly, or contact your workspace admin.",
  },
  {
    name: "an upstream billing stop",
    cause: Object.assign(new Error("Insufficient credit balance"), {
      statusCode: 402,
    }),
    status: 402,
    message:
      "The AI provider reported a billing or credit problem. An administrator should check the provider account.",
  },
  {
    // The response body alone, with no status: how a provider's rejected key
    // reaches the classifier when the adapter cannot preserve the 401.
    name: "a rejected credential",
    cause: {
      error: {
        code: "invalid_api_key",
        message: "Incorrect API key provided.",
        type: "invalid_request_error",
      },
    },
    status: 502,
    message:
      "The AI provider rejected the configured credentials. An administrator should check the provider API key in organization settings.",
  },
] as const satisfies readonly ProviderFailureCase[];

/**
 * The failure a document-review model step returns: the step's own error, with
 * the provider's underneath it. Reading the cause is the whole point of the
 * classification, so the fixture must be caused rather than bare.
 */
export const modelStepFailure = (cause: unknown): WorkflowIntegrationError =>
  new WorkflowIntegrationError({
    message: "The model step did not complete",
    cause,
  });
