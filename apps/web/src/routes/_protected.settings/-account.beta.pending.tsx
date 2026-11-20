import type { ReactNode } from "react";

import { CheckboxFace } from "@stll/ui/control-face";
import { SettingsRow, SettingsSection } from "@stll/ui/settings";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeaderPending } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";

/*
 * The beta page's one layout, drawn by both phases: the heading, then one
 * row per preview with its name, its line and its checkbox. The page fills
 * each row's control with a live checkbox; the pending phase, and the
 * self-serve previews while their enrolment loads, with the checkbox's face.
 */

/** The previews the page lists, in order. */
export type BetaFeature = "workflows" | "timeBilling" | "localAgents" | "inbox";

/** The previews in order, by name and line; the toggles are the page's. */
const BETA_FEATURES = {
  workflows: {
    title: "common.workflows",
    description: "knowledge.sections.workflows.description",
  },
  timeBilling: {
    title: "common.timeBilling",
    description: "settings.account.betaTimeBillingDescription",
  },
  localAgents: {
    title: "settings.account.betaLocalAgents",
    description: "settings.account.betaLocalAgentsDescription",
  },
  inbox: {
    title: "settings.account.betaInbox",
    description: "settings.account.betaInboxDescription",
  },
} as const satisfies Record<
  BetaFeature,
  { title: PendingTextKey; description: PendingTextKey }
>;

/** The id a preview's row names its title and line by (`settingsRowIds`). */
export const betaFeatureRowId = (feature: BetaFeature) =>
  `beta-feature-${feature}`;

type BetaFeatureRowProps = {
  feature: BetaFeature;
  /** The checkbox, or its face. */
  children: ReactNode;
};

/** One preview's row: its name and its line, then its checkbox. */
export const BetaFeatureRow = ({ children, feature }: BetaFeatureRowProps) => (
  <SettingsRow
    description={
      <PendingText
        barClassName="w-72 max-w-full"
        id={BETA_FEATURES[feature].description}
      />
    }
    id={betaFeatureRowId(feature)}
    interaction="label"
    title={
      <PendingText barClassName="w-28" id={BETA_FEATURES[feature].title} />
    }
  >
    {children}
  </SettingsRow>
);

/** A preview's row with its checkbox's face (the choice waits on data). */
const BetaFeatureRowPending = ({ feature }: { feature: BetaFeature }) => (
  <BetaFeatureRow feature={feature}>
    <CheckboxFace />
  </BetaFeatureRow>
);

/** The self-serve previews while their enrolment loads. */
export const SelfServeFeaturePanelsPending = () => (
  <>
    <BetaFeatureRowPending feature="timeBilling" />
    <BetaFeatureRowPending feature="localAgents" />
  </>
);

type BetaPageShellProps = {
  /** The browser-held previews: workflows, then the inbox. */
  workflows: ReactNode;
  inbox: ReactNode;
  /** The previews this deployment offers for self-serve enrolment. */
  selfServe: ReactNode;
};

/** The beta page's layout, in both phases. */
export const BetaPageShell = ({
  inbox,
  selfServe,
  workflows,
}: BetaPageShellProps) => (
  <>
    <SettingsPageHeaderPending
      description="settings.account.betaDescription"
      title="settings.account.beta"
    />
    <SettingsSection>
      {workflows}
      {selfServe}
      {inbox}
    </SettingsSection>
  </>
);

const BetaPendingView = () => (
  <SettingsPagePending area="account">
    <BetaPageShell
      inbox={<BetaFeatureRowPending feature="inbox" />}
      selfServe={<SelfServeFeaturePanelsPending />}
      workflows={<BetaFeatureRowPending feature="workflows" />}
    />
  </SettingsPagePending>
);

export const BetaPending = framePendingView(BetaPendingView);
