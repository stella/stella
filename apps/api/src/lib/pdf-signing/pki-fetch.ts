/**
 * Outbound requests to the URLs a signer's certificate names: issuer
 * certificates (AIA caIssuers), OCSP responders and CRL distribution points.
 *
 * Those URLs come from a certificate the desktop posted, so they are
 * attacker-chosen as far as the API is concerned. Every request goes through
 * the shared outbound guard (public addresses only, DNS pinned, no
 * redirects) with a small byte cap and a short timeout. Plain HTTP is
 * allowed because PKI distribution points are conventionally served over it;
 * what they serve is signed and verified by whoever reads it.
 */

import { Result } from "better-result";

import { Temporal } from "@stll/time";

import {
  fetchWithResolvedAddress,
  OUTBOUND_PROTOCOL_POLICY,
  validateOutboundFetchTarget,
} from "@/api/lib/safe-outbound-fetch";

const PKI_FETCH_TIMEOUT_MS = 5000;

export type PkiFetchRequest = {
  body?: Uint8Array;
  contentType?: string;
  maxBytes: number;
  method: "GET" | "POST";
  url: string;
};

/** The response body, or `null` for any failure: PKI data is best effort. */
export type PkiFetcher = (
  request: PkiFetchRequest,
) => Promise<Uint8Array | null>;

/**
 * A fetcher that stops fetching once `budgetMs` has passed. Each request is
 * already bounded; this bounds how many of them one signing step waits on,
 * since a certificate names the URLs and so decides how many there are.
 */
export const withFetchBudget = (
  fetcher: PkiFetcher,
  budgetMs: number,
  now: () => number = () => Temporal.Now.instant().epochMilliseconds,
): PkiFetcher => {
  const deadline = now() + budgetMs;
  return async (request) => (now() >= deadline ? null : await fetcher(request));
};

export const safePkiFetch: PkiFetcher = async ({
  body,
  contentType,
  maxBytes,
  method,
  url,
}) => {
  const target = await validateOutboundFetchTarget(url, {
    protocolPolicy: OUTBOUND_PROTOCOL_POLICY.HTTP_AND_HTTPS,
    timeoutMs: PKI_FETCH_TIMEOUT_MS,
  });
  if (Result.isError(target)) {
    return null;
  }

  const response = await fetchWithResolvedAddress({
    addresses: target.value.addresses,
    body,
    headers:
      contentType === undefined ? undefined : { "content-type": contentType },
    maxBytes,
    method,
    redirect: "error",
    timeoutMs: PKI_FETCH_TIMEOUT_MS,
    url: target.value.url,
  });
  if (Result.isError(response) || !response.value.ok) {
    return null;
  }
  return new Uint8Array(response.value.body);
};
