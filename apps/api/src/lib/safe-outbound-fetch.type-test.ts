import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import * as outbound from "@/api/lib/safe-outbound-fetch";

type RequestExport = {
  [Name in keyof typeof outbound]: (typeof outbound)[Name] extends (
    options: infer Options,
  ) => unknown
    ? "maxBytes" extends keyof Options
      ? Name
      : never
    : never;
}[keyof typeof outbound];

type RequestContract<Name extends RequestExport> = Parameters<
  (typeof outbound)[Name]
>[0] extends { permit: ThirdPartyOutboundPermit }
  ? true
  : false;

export const outboundPermitContract = {
  fetchWithResolvedAddress: outbound.fetchWithResolvedAddress,
  fetchStreamWithResolvedAddress: outbound.fetchStreamWithResolvedAddress,
  safeOutboundFetchBytes: outbound.safeOutboundFetchBytes,
  safeOutboundFetchStream: outbound.safeOutboundFetchStream,
} as const satisfies {
  [Name in RequestExport]: RequestContract<Name> extends true
    ? (typeof outbound)[Name]
    : never;
};

const options = {
  addresses: [{ address: "192.0.2.1", family: 4 }],
  maxBytes: 1024,
  timeoutMs: 1000,
  url: new URL("https://example.test"),
} as const;

// These calls are compiled as contracts and are never executed.
export const requireOutboundPermit = async () =>
  await Promise.all(
    Object.values(outboundPermitContract).map(async (request) => {
      // @ts-expect-error An outbound request requires its boundary's permit.
      const missingPermit = await request(options);
      // @ts-expect-error The permit field requires an issued identity.
      const undefinedPermit = await request({ ...options, permit: undefined });
      // @ts-expect-error An ordinary object is not an outbound permit.
      const ordinaryPermit = await request({ ...options, permit: {} });
      return { missingPermit, undefinedPermit, ordinaryPermit };
    }),
  );

// A header deadline leaves the body to the caller's signal, so omitting one
// would make the body read unbounded.
export const requireBodyBound = async (permit: ThirdPartyOutboundPermit) => {
  const target = { maxBytes: 1024, permit, url: "https://example.test" };
  // @ts-expect-error A header deadline needs a signal that bounds the body.
  const unboundedBody = await outbound.safeOutboundFetchBytes({
    ...target,
    timeout: { type: "headers", ms: 1000 },
  });
  const signalBound = await outbound.safeOutboundFetchBytes({
    ...target,
    signal: AbortSignal.timeout(1000),
    timeout: { type: "headers", ms: 1000 },
  });
  const idleBound = await outbound.safeOutboundFetchBytes({
    ...target,
    timeout: { type: "idle", ms: 1000 },
  });
  return { unboundedBody, signalBound, idleBound };
};
