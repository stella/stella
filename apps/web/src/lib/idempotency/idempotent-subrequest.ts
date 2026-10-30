import { sha256Hex } from "@stll/sha256/browser";

import type { IdempotentRequest } from "@/lib/idempotency/use-idempotent-submit";

/** A multipart submit assigns each create step its own bounded, repeatable key. */
export const deriveIdempotentRequest = async (
  request: IdempotentRequest,
  operation: string,
) => ({
  headers: {
    "Idempotency-Key": await sha256Hex(
      JSON.stringify([request.headers["Idempotency-Key"], operation]),
    ),
  },
});
