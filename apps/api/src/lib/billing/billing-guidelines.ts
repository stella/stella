import { and, eq, inArray, isNull, or } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  agentSkillResources,
  agentSkills,
  billingGuidelineFiles,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export const BILLING_GUIDELINE_MAX_FILES_PER_CLIENT = 10;

type LoadBillingGuidelinesOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  clientIds: readonly SafeId<"contact">[];
};

export const loadBillingGuidelines = async ({
  safeDb,
  organizationId,
  clientIds,
}: LoadBillingGuidelinesOptions) =>
  await safeDb((tx) =>
    tx
      .select({
        fileId: agentSkillResources.id,
        fileName: agentSkillResources.path,
        content: agentSkillResources.content,
        clientId: billingGuidelineFiles.clientId,
      })
      .from(billingGuidelineFiles)
      .innerJoin(
        agentSkillResources,
        and(
          eq(agentSkillResources.id, billingGuidelineFiles.resourceId),
          eq(agentSkillResources.organizationId, organizationId),
        ),
      )
      .innerJoin(
        agentSkills,
        and(
          eq(agentSkills.id, agentSkillResources.skillId),
          eq(agentSkills.organizationId, organizationId),
          eq(agentSkills.scope, "team"),
        ),
      )
      .where(
        and(
          eq(billingGuidelineFiles.organizationId, organizationId),
          eq(agentSkillResources.kind, "knowledge"),
          clientIds.length === 0
            ? isNull(billingGuidelineFiles.clientId)
            : or(
                isNull(billingGuidelineFiles.clientId),
                inArray(billingGuidelineFiles.clientId, [...clientIds]),
              ),
        ),
      )
      .limit(1 + clientIds.length * BILLING_GUIDELINE_MAX_FILES_PER_CLIENT),
  );
