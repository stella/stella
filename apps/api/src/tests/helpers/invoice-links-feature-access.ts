import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";

type InvoiceLinksPrincipal = { organizationId: string; userId: string };

/** Explicit link authority for behavior fixtures, separate from billing-only enrolment. */
export const invoiceLinksSnapshot = (principal: InvoiceLinksPrincipal) =>
  buildFeatureAccessSnapshot({
    ...principal,
    identity: { email: "billing@example.test", emailVerified: true },
    enrolments: [{ ...principal, featureId: "time-billing" }],
    grants: {
      "invoice-links": [
        { type: "organization", organizationId: principal.organizationId },
      ],
    },
  });
