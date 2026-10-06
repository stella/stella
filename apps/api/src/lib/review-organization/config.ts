import * as v from "valibot";

import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import {
  AUTH_PROVIDER_ID_PATTERN,
  brandPersistedOrganizationId,
} from "@/api/lib/safe-id-boundaries";

/**
 * The one restricted review account and the organization it owns. Only this
 * pair is ever reset and reseeded with sample data; every other organization
 * is out of reach of this module.
 */
export type ReviewOrganizationConfig = {
  email: string;
  organizationId: SafeId<"organization">;
  /** The demo organization, which the reset must never touch. */
  demoOrganizationId: string | null;
  /** The demo account, which must never be the review account. */
  demoEmail: string | null;
};

const emailSchema = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email());
const organizationIdSchema = v.pipe(
  v.string(),
  v.regex(AUTH_PROVIDER_ID_PATTERN),
);

type ConfigSource = Readonly<Record<string, unknown>>;

const optionalString = (source: ConfigSource, key: string): string | null => {
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
};

/**
 * Read the review identity from configuration. Returns null unless both
 * values are present and well formed, so an unconfigured deployment has no
 * review organization at all.
 */
export const reviewOrganizationConfigFrom = (
  source: ConfigSource,
): ReviewOrganizationConfig | null => {
  const email = v.safeParse(
    emailSchema,
    optionalString(source, "APP_REVIEW_ACCOUNT_EMAIL"),
  );
  const organizationId = v.safeParse(
    organizationIdSchema,
    optionalString(source, "APP_REVIEW_ORGANIZATION_ID"),
  );
  if (!email.success || !organizationId.success) {
    return null;
  }
  const demoEmail = optionalString(source, "DEMO_ACCOUNT_EMAIL");
  return {
    email: email.output,
    organizationId: brandPersistedOrganizationId(organizationId.output),
    demoOrganizationId: optionalString(source, "DEMO_ACCOUNT_ORGANIZATION_ID"),
    demoEmail: demoEmail === null ? null : demoEmail.trim().toLowerCase(),
  };
};

/** The deployment's review identity, or null when it is not configured. */
export const readReviewOrganizationConfig =
  (): ReviewOrganizationConfig | null =>
    // The environment module is read by key so this stays valid whichever
    // keys the deployment declares; undeclared keys read as absent.
    reviewOrganizationConfigFrom(env);
