import { toSafeId as brandSafeId } from "@stll/api-contract/safe-id";

import type { SafeId, SafeIdType } from "@/lib/api-contract";

export type { SafeId, SafeIdType } from "@/lib/api-contract";

/**
 * The one web-side entry point for branding a raw identifier. It narrows the
 * portable contract helper to the id kinds the API declares, so a typo in the
 * type argument fails to compile. The brand asserts format only: every request
 * built from one is still authorized server-side.
 */
export const toSafeId = <TType extends SafeIdType>(
  value: string,
): SafeId<TType> => brandSafeId<TType>(value);
