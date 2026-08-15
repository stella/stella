// Passive regression fixture for
// `no-raw-router-invalidation/no-raw-router-invalidation`.

import { useRouter } from "@tanstack/react-router";

export const useRawRouterInvalidation = () => {
  const router = useRouter();
  return async () => {
    // oxlint-disable-next-line no-raw-router-invalidation/no-raw-router-invalidation -- fixture proves raw router invalidation is confined to owned boundaries
    await router.invalidate();
  };
};

export const useDestructuredRouterInvalidation = () => {
  const { invalidate } = useRouter();
  return async () => {
    // oxlint-disable-next-line no-raw-router-invalidation/no-raw-router-invalidation -- fixture proves destructuring cannot evade the boundary
    await invalidate();
  };
};

export const unrelatedInvalidation = (guard: { invalidate: () => void }) => {
  guard.invalidate();
};
