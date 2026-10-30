import type { ReviewAccountConfig } from "@/api/lib/auth/review-account-policy";
import { isSyntheticPrincipal } from "@/api/lib/synthetic-principal/constants";

/**
 * Whose activity a server event describes. Product analytics count customers;
 * the synthetic principal and the restricted review account are the service's
 * own, and their activity is not product usage.
 */
export const PRINCIPAL_AUDIENCE = {
  customer: "customer",
  review: "review",
  synthetic: "synthetic",
} as const;

export type PrincipalAudience =
  (typeof PRINCIPAL_AUDIENCE)[keyof typeof PRINCIPAL_AUDIENCE];

type AudiencePrincipal = {
  organizationId: string;
  userId: string;
};

/**
 * Classifies by the principal's own kind: the synthetic principal's identity,
 * or the organization configured for the review account. Never by a list of
 * ids kept in the analytics path.
 */
export const principalAudience = (
  principal: AudiencePrincipal,
  reviewAccount: ReviewAccountConfig,
): PrincipalAudience => {
  if (isSyntheticPrincipal(principal)) {
    return PRINCIPAL_AUDIENCE.synthetic;
  }
  if (
    reviewAccount.organizationId !== undefined &&
    principal.organizationId === reviewAccount.organizationId
  ) {
    return PRINCIPAL_AUDIENCE.review;
  }
  return PRINCIPAL_AUDIENCE.customer;
};

declare const customerDistinctIdBrand: unique symbol;

/**
 * A distinct id proven to belong to a customer. Product-usage events accept
 * only this id, so an event cannot reach analytics without its principal
 * having been classified first.
 */
export type CustomerDistinctId = string & {
  readonly [customerDistinctIdBrand]: true;
};

const isCustomerDistinctId = (
  _userId: string,
  audience: PrincipalAudience,
): _userId is CustomerDistinctId => audience === PRINCIPAL_AUDIENCE.customer;

export type ProductUsagePrincipal = {
  distinctId: CustomerDistinctId;
  organizationId: string;
};

/** The principal as product usage, or null when it is the service's own. */
export const productUsagePrincipal = (
  principal: AudiencePrincipal,
  reviewAccount: ReviewAccountConfig,
): ProductUsagePrincipal | null => {
  const { organizationId, userId } = principal;
  return isCustomerDistinctId(
    userId,
    principalAudience(principal, reviewAccount),
  )
    ? { distinctId: userId, organizationId }
    : null;
};
