/**
 * A URL a publisher handed back, held to that publisher's own hosts.
 *
 * Most requests an adapter sends are built on a fixed base. Some are not: a
 * link read out of a listing, a content address from a metadata record, a
 * stored document URL. {@link publisherTarget} is how such a URL becomes a
 * request target: https, no credentials, on one of the hosts declared for the
 * adapter's publisher in `publisher-policy.ts`. The `require-safe-outbound-target`
 * lint rule accepts its result as a proven origin.
 */

import { Result, TaggedError } from "better-result";

import { publisherHosts } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";

/** A publisher URL that is not on the publisher's declared hosts. */
export class PublisherTargetError extends TaggedError("PublisherTargetError")<{
  adapterKey: AdapterKey;
  url: string;
  message: string;
}> {}

/**
 * The URL as a request target for `adapterKey`'s publisher, or why it is not
 * one. The fragment is dropped: it is never sent.
 */
export const publisherTarget = (
  adapterKey: AdapterKey,
  url: string | URL,
): Result<string, PublisherTargetError> => {
  const raw = String(url);
  const refused = (reason: string) =>
    Result.err(
      new PublisherTargetError({
        adapterKey,
        url: raw,
        message: `${reason}: ${raw}`,
      }),
    );
  const parsed = URL.parse(raw);
  if (parsed === null) {
    return refused("not a URL");
  }
  if (parsed.protocol !== "https:") {
    return refused("not https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return refused("carries credentials");
  }
  // `host` keeps a non-default port, so a port on a declared host fails here.
  if (!publisherHosts(adapterKey).includes(parsed.host)) {
    return refused("not a publisher host");
  }
  parsed.hash = "";
  return Result.ok(parsed.href);
};
