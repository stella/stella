/**
 * The organization's switch for asking the decision model for Anchor
 * Verification verdicts (`verdict-decider.ts`). Off by default and for an
 * organization that never saved settings.
 */

import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { organizationSettings } from "@/api/db/schema";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { resolveVerdictDecider } from "@/api/lib/lists/verification/verdict-decider";
import type { VerdictDecider } from "@/api/lib/lists/verification/verdict-decider";
import { hasCustomerDecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";

type SettingsReader = Pick<Transaction, "select">;

/** The switch as stored now. */
export const readVerificationDecisionModelEnabled = async (
  tx: SettingsReader,
  organizationId: SafeId<"organization">,
): Promise<boolean> =>
  (
    await tx
      .select({
        enabled: organizationSettings.verificationDecisionModelEnabled,
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1)
  ).at(0)?.enabled ?? false;

type ReadVerdictDeciderOptions = {
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  /** External decision-model boundary; supplied by focused tests. */
  decisionModel?: DecisionModel | null | undefined;
};

/** Who decides this organization's verdicts, from its switch and its AI
 *  configuration. */
export const readVerdictDecider = async (
  tx: SettingsReader,
  { organizationId, orgAIConfig, decisionModel }: ReadVerdictDeciderOptions,
): Promise<VerdictDecider> =>
  resolveVerdictDecider({
    enabled: await readVerificationDecisionModelEnabled(tx, organizationId),
    orgAIConfig,
    ...(decisionModel === undefined
      ? {}
      : { resolveModel: () => decisionModel }),
  });

type UpdateVerificationDecisionModelOptions = {
  organizationId: SafeId<"organization">;
  enabled: boolean;
  orgAIConfig: OrgAIConfig | null;
  recordAuditEvent: AuditRecorder;
};

/**
 * Turn the switch on or off and audit the change with the value it
 * replaced. Turning it on needs a decision model the organization can
 * reach; turning it off never does. The write lands only on the value it
 * read, so a concurrent save is told the setting changed.
 */
export const updateVerificationDecisionModel = async (
  tx: Transaction,
  {
    organizationId,
    enabled,
    orgAIConfig,
    recordAuditEvent,
  }: UpdateVerificationDecisionModelOptions,
) => {
  if (enabled && !hasCustomerDecisionModel(orgAIConfig)) {
    return { type: "unavailable" } as const;
  }
  await tx
    .insert(organizationSettings)
    .values({ id: createSafeId<"organizationSettings">(), organizationId })
    .onConflictDoNothing({ target: organizationSettings.organizationId });
  const previous = await readVerificationDecisionModelEnabled(
    tx,
    organizationId,
  );
  if (previous === enabled) {
    return { type: "updated", enabled } as const;
  }
  const written = await tx
    .update(organizationSettings)
    .set({ verificationDecisionModelEnabled: enabled, updatedAt: new Date() })
    .where(
      and(
        eq(organizationSettings.organizationId, organizationId),
        eq(organizationSettings.verificationDecisionModelEnabled, previous),
      ),
    )
    .returning({ id: organizationSettings.id });
  if (written.length === 0) {
    return { type: "changed" } as const;
  }
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
    resourceId: organizationId,
    changes: {
      verificationDecisionModelEnabled: { old: previous, new: enabled },
    },
  });
  return { type: "updated", enabled } as const;
};
