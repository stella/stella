import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { mayReadPublicLaw } from "@/api/lib/usage/organization-access-state";

export const mayReadPublicLawForOrganization = async (
  organizationId: SafeId<"organization">,
) => await mayReadPublicLaw(rootDb, organizationId);
