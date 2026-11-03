import { Result } from "better-result";

import type { PublisherRemovalRead } from "@/api/handlers/case-law/ingestion/removal-reconciliation";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

/** Synthetic publisher observations use the same typed failure channel as real probes. */
export const publisherRemovalProbe =
  (
    probe: (
      identity: string,
      signal: AbortSignal,
    ) => Promise<PublisherRemovalRead>,
  ) =>
  async (identity: string, signal: AbortSignal) =>
    await Result.tryPromise({
      try: async () => await probe(identity, signal),
      catch: (cause) =>
        cause instanceof AdapterFetchError
          ? cause
          : new AdapterFetchError({
              message: "Synthetic publisher probe failed",
              adapterKey: "uk-fcl",
              cursor: null,
              cause,
            }),
    });
