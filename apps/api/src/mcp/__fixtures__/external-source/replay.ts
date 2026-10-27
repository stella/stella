import { panic, Result } from "better-result";

import { runEntityCheck } from "@stll/business-registries/entity-checks";

import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import {
  BUSINESS_REGISTRY_DISPATCH,
  executeRegistryLookup,
} from "@/api/lib/business-registries/dispatch";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type ReplayOptions<T> = {
  body: string;
  sourceUrl: string;
  contentType: string;
  operation: () => Promise<T>;
};

// Registry clients own decoding and normalization. Replay their transport only;
// callers run these fixtures sequentially because fetch is process-global.
export const replay = async <T>({
  body,
  sourceUrl,
  contentType,
  operation,
}: ReplayOptions<T>): Promise<T> => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const fixtureFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== sourceUrl) {
        return panic(`Unexpected fixture replay request: ${url}`);
      }
      requests += 1;
      return await Promise.resolve(
        new Response(body, { headers: { "content-type": contentType } }),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  globalThis.fetch = fixtureFetch;
  try {
    const result = await operation();
    if (requests !== 1) {
      return panic(`Expected one fixture replay request, received ${requests}`);
    }
    return result;
  } finally {
    globalThis.fetch = originalFetch;
  }
};

export const replayRegistryLookup = async (
  body: string,
  permit: ThirdPartyOutboundPermit,
) => {
  const result = await replay({
    body,
    sourceUrl:
      "https://data.brreg.no/enhetsregisteret/api/enheter/123456785",
    contentType: "application/json",
    operation: async () =>
      await executeRegistryLookup({
        handler: BUSINESS_REGISTRY_DISPATCH.brreg,
        query: "123456785",
        observer: "unobserved",
        permit,
      }),
  });
  if (HandlerError.is(result)) {
    return panic("Registry fixture replay failed", result);
  }
  return result;
};

export const replayCounterpartyCheck = async (body: string) => {
  const result = await replay({
    body,
    sourceUrl:
      "https://adisrws.mfcr.cz/adistc/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP",
    contentType: "text/xml; charset=utf-8",
    operation: async () =>
      await runEntityCheck({
        kind: "cz-vat-reliability",
        subject: { type: "tax-id", value: "CZ12345679" },
        observer: "unobserved",
      }),
  });
  if (Result.isError(result)) {
    return panic("Counterparty fixture replay failed", result.error);
  }
  if (result.value.status === "unavailable") {
    return panic("Counterparty fixture replay did not decode the response");
  }
  return result.value;
};
