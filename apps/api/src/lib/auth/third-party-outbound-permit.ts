import { panic } from "better-result";

const THIRD_PARTY_OUTBOUND_PERMIT: unique symbol = Symbol(
  "ThirdPartyOutboundPermit",
);

/**
 * Authority to send a request to a third-party service: a public register, a
 * legislation API, a court publisher. Every client that reaches one takes a
 * permit, so holding one is the only way to call it.
 *
 * The brand key is private to this module, so `grantThirdPartyOutboundPermit`
 * is the only way to construct one. It is called only at a direct call
 * boundary (an HTTP route, an MCP transport request, a native chat tool); the
 * chat script runner never holds a permit, so a read run from a script cannot
 * reach a third party. `third-party-outbound-permit.test.ts` pins the files
 * that may grant one.
 */
export type ThirdPartyOutboundPermit = {
  readonly [THIRD_PARTY_OUTBOUND_PERMIT]: true;
};

const issuedPermits = new WeakSet<object>();

export const grantThirdPartyOutboundPermit = (): ThirdPartyOutboundPermit => {
  const permit = Object.freeze({
    [THIRD_PARTY_OUTBOUND_PERMIT]: true,
  } as const);
  issuedPermits.add(permit);
  return permit;
};

/** A request carries the identity issued by its direct boundary. */
export const assertThirdPartyOutboundPermit = (permit: unknown): void => {
  if (
    typeof permit !== "object" ||
    permit === null ||
    !issuedPermits.has(permit)
  ) {
    panic("An issued third-party outbound permit is required");
  }
};
