import { InfoSoudClient } from "@stll/infosoud";

let sharedClient: InfoSoudClient | undefined;

/**
 * One process-wide InfoSoud client, created lazily on first use.
 *
 * A single instance is required for the client's politeness throttle to pace
 * concurrent callers, since the throttle is per-instance; a per-request client
 * would defeat it. Caching is enabled only for the courts list (its default
 * 24h TTL), which is identical for every workspace and rarely changes.
 * Per-case reads keep a 0ms TTL so lookups and the tracked-case sync always
 * see live registry data.
 */
export const getInfoSoudClient = (): InfoSoudClient => {
  sharedClient ??= new InfoSoudClient({
    cache: {
      caseTtlMs: 0,
      eventDetailTtlMs: 0,
      hearingsTtlMs: 0,
    },
  });
  return sharedClient;
};
