/**
 * Which managed models serve an organization's work. The free floor runs
 * every role on the deployment's fast model; every other standing keeps the
 * per-role models. Work on the organization's own key ignores the tier: the
 * organization chose those models and pays for them.
 */

import type { OrganizationAccessType } from "@/api/lib/usage/organization-access";

export const MANAGED_MODEL_TIER = {
  standard: "standard",
  fast: "fast",
} as const;

export type ManagedModelTier =
  (typeof MANAGED_MODEL_TIER)[keyof typeof MANAGED_MODEL_TIER];

/**
 * `self_managed_keys`, `ended` and `unavailable` never reach a managed model
 * (`allowsInstanceModels` refuses them); they keep the standard tier so the
 * tier changes nothing outside the free floor.
 */
export const MANAGED_MODEL_TIER_BY_ACCESS = {
  paid: MANAGED_MODEL_TIER.standard,
  evaluation: MANAGED_MODEL_TIER.standard,
  free: MANAGED_MODEL_TIER.fast,
  self_managed_keys: MANAGED_MODEL_TIER.standard,
  ended: MANAGED_MODEL_TIER.standard,
  unavailable: MANAGED_MODEL_TIER.standard,
} as const satisfies Record<OrganizationAccessType, ManagedModelTier>;
