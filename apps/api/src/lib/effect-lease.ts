import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";

const EFFECT_LEASE_KIND: unique symbol = Symbol("stella.effectLeaseKind");

/**
 * Proof that one worker owns one external-effect attempt. The kind parameter
 * prevents a token claimed for one effect domain from settling another.
 */
export type EffectLease<Kind extends string> = {
  readonly [EFFECT_LEASE_KIND]: Kind;
  readonly kind: Kind;
  readonly token: SafeId<"effectLease">;
};

export const createEffectLease = <const Kind extends string>(
  kind: Kind,
): EffectLease<Kind> => ({
  [EFFECT_LEASE_KIND]: kind,
  kind,
  token: createSafeId<"effectLease">(),
});
