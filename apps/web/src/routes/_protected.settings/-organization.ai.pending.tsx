import type { ReactNode } from "react";

import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";
import { AIConfigCardPending } from "@/routes/_protected.settings/organization/-components/organization/ai-config-card.pending";

/*
 * The AI page's one layout, drawn by both phases: the provider settings
 * (heading, providers, instructions, on/off cards, keys), then the local
 * run approval ceiling and the billing drafts card. The page fills the
 * slots with the live cards; the pending phase draws the provider settings'
 * pending phase and leaves out the two cards that depend on a feature (a
 * member's computers, time and billing), which join once read.
 */

type AIConfigPageShellProps = {
  /** The provider settings. */
  providerSettings: ReactNode;
  /** The approval ceiling for chats run on a member's computer. */
  localRunApprovalCeiling?: ReactNode;
  /** Billing drafts, where time and billing is on. */
  billingDrafts?: ReactNode;
};

/** The AI page's layout, in both phases. */
export const AIConfigPageShell = ({
  billingDrafts,
  localRunApprovalCeiling,
  providerSettings,
}: AIConfigPageShellProps) => (
  <>
    {providerSettings}
    {localRunApprovalCeiling}
    {billingDrafts}
  </>
);

const AIConfigPendingView = () => (
  <SettingsPagePending area="organization">
    <AIConfigPageShell providerSettings={<AIConfigCardPending />} />
  </SettingsPagePending>
);

export const AIConfigPending = framePendingView(AIConfigPendingView);
