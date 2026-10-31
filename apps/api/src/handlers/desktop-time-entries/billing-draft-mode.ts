import { and, eq } from "drizzle-orm";

import type {
  DesktopBillingDraftEffectiveMode,
  DesktopBillingDraftMode,
} from "@stll/api-contract/desktop-billing-drafts";
import { DESKTOP_BILLING_DRAFT_REFUSAL_CODE } from "@stll/api-contract/desktop-billing-drafts";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  AI_BILLING_DRAFTS_MODE,
  billingDraftUserSettings,
  DEFAULT_AI_BILLING_DRAFTS_MODE,
  organizationSettings,
} from "@/api/db/schema";
import { readFirmGuidelineBound } from "@/api/lib/billing/billing-guidelines";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type BillingDraftGateOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/** The organization's AI billing drafts switch, its default while unset. */
export const readOrganizationDraftsMode = async ({
  tx,
  organizationId,
}: Pick<BillingDraftGateOptions, "tx" | "organizationId">) =>
  (
    await tx
      .select({ mode: organizationSettings.aiBillingDraftsMode })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1)
  ).at(0)?.mode ?? DEFAULT_AI_BILLING_DRAFTS_MODE;

/** The organization's switch and the caller's own consent, read together. */
export const readBillingDraftGate = async ({
  tx,
  organizationId,
  userId,
}: BillingDraftGateOptions) => {
  const organizationMode = await readOrganizationDraftsMode({
    tx,
    organizationId,
  });
  const own = await tx
    .select({
      consentAt: billingDraftUserSettings.consentAt,
      preference: billingDraftUserSettings.preference,
    })
    .from(billingDraftUserSettings)
    .where(
      and(
        eq(billingDraftUserSettings.organizationId, organizationId),
        eq(billingDraftUserSettings.userId, userId),
      ),
    )
    .limit(1);
  return {
    organizationMode,
    consentAt: own.at(0)?.consentAt ?? null,
    preference: own.at(0)?.preference ?? null,
  };
};

export type BillingDraftGate = Awaited<ReturnType<typeof readBillingDraftGate>>;

/** The organization's off switch: anything but `enabled` stops all drafting,
 * plain descriptions included. */
const isSwitchedOff = ({
  organizationMode,
}: Pick<BillingDraftGate, "organizationMode">) =>
  organizationMode !== AI_BILLING_DRAFTS_MODE.ENABLED;

/**
 * What a consenting member drafts while the organization allows drafting:
 * guideline checks, billing codes and flags once a firm guideline file is
 * bound, plain descriptions otherwise. Client files alone never switch
 * guided drafting on.
 */
export const draftingModeFor = (
  firmGuidelineBound: boolean,
): DesktopBillingDraftMode => (firmGuidelineBound ? "guided" : "plain");

type LoadBillingDraftGateOptions = Omit<BillingDraftGateOptions, "tx"> & {
  safeDb: SafeDb;
};

/** {@link readBillingDraftGate} in its own scoped transaction. */
export const loadBillingDraftGate = async ({
  safeDb,
  organizationId,
  userId,
}: LoadBillingDraftGateOptions) =>
  await safeDb(
    async (tx) => await readBillingDraftGate({ tx, organizationId, userId }),
  );

/**
 * The refusal that stops drafting before any model call: the organization
 * switched AI billing drafts off, or the caller has not consented.
 * `undefined` when drafting may proceed.
 */
export const billingDraftGateRefusal = (
  gate: Pick<BillingDraftGate, "organizationMode" | "consentAt">,
) => {
  if (isSwitchedOff(gate)) {
    return new HandlerError({
      status: 403,
      code: DESKTOP_BILLING_DRAFT_REFUSAL_CODE.organizationOff,
      message: "AI billing drafts are switched off for this organization",
    });
  }
  if (gate.consentAt === null) {
    return new HandlerError({
      status: 403,
      code: DESKTOP_BILLING_DRAFT_REFUSAL_CODE.consentRequired,
      message: "AI billing drafts require personal consent",
    });
  }
  return undefined;
};

type ReadEffectiveDraftModeOptions = Pick<
  BillingDraftGateOptions,
  "tx" | "organizationId"
> &
  Pick<BillingDraftGate, "organizationMode">;

/** Which drafting a consenting member of the organization gets. */
export const readEffectiveDraftMode = async ({
  tx,
  organizationId,
  organizationMode,
}: ReadEffectiveDraftModeOptions): Promise<DesktopBillingDraftEffectiveMode> =>
  isSwitchedOff({ organizationMode })
    ? "off"
    : draftingModeFor(await readFirmGuidelineBound({ tx, organizationId }));
