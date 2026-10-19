export const SYNTHETIC_PRINCIPAL = {
  user: {
    id: "synthetic-prod-user",
    email: "monitor@synthetic.stll.app",
    name: "Product Monitor",
  },
  org: {
    id: "synthetic-prod-org",
    name: "Product Monitoring",
    slug: "stella:monitoring:synthetic-prod-org",
  },
  memberId: "synthetic-prod-member",
} as const;

type SyntheticPrincipalIdentity = {
  userId?: string;
  organizationId?: string;
  email?: string;
};

export const isSyntheticPrincipal = ({
  userId,
  organizationId,
  email,
}: SyntheticPrincipalIdentity): boolean =>
  userId === SYNTHETIC_PRINCIPAL.user.id ||
  organizationId === SYNTHETIC_PRINCIPAL.org.id ||
  email?.trim().toLowerCase() === SYNTHETIC_PRINCIPAL.user.email;

export const SYNTHETIC_SESSION_PREFIX = "synthetic-session-";
export const SYNTHETIC_SESSION_LIFETIME_MS = 30 * 60 * 1000;
export const SYNTHETIC_SESSION_CONTROL_ID = "monitoring-session";

export const SYNTHETIC_SESSION_CONTROL_STATUSES = [
  "enabled",
  "revoked",
] as const;
