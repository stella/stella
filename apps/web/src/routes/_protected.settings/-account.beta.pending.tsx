import type { ReactNode } from "react";

import { CheckboxFace, LabelFace } from "@stll/ui/control-face";
import { Frame, FramePanel } from "@stll/ui/frame";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeaderPending } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";

/*
 * The beta page's one layout, drawn by both phases: the heading, then one
 * panel per preview with its name, its line and its switch. The page fills
 * each panel's control with a live checkbox; the pending phase, and the
 * self-serve previews while their enrolment loads, with the checkbox's face.
 */

/** The previews the page lists, in order. */
export type BetaFeature = "workflows" | "timeBilling" | "localAgents" | "inbox";

type BetaFeaturePanelProps = {
  title: PendingTextKey;
  description: PendingTextKey;
  /** The checkbox and its caption. */
  children: ReactNode;
};

/** One preview's panel: its name, its line, then its checkbox. */
export const BetaFeaturePanel = ({
  children,
  description,
  title,
}: BetaFeaturePanelProps) => (
  <FramePanel>
    <div className="flex flex-col gap-3 p-1">
      <h2 className="text-sm font-medium">
        <PendingText barClassName="w-28" id={title} />
      </h2>
      <p className="text-muted-foreground text-xs">
        <PendingText barClassName="w-72 max-w-full" id={description} />
      </p>
      {children}
    </div>
  </FramePanel>
);

/** The previews in order, by name and line; the toggles are the page's. */
export const BETA_FEATURES = {
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

/** A preview's panel with its checkbox's face (the choice waits on data). */
const BetaFeaturePanelPending = ({ feature }: { feature: BetaFeature }) => (
  <BetaFeaturePanel {...BETA_FEATURES[feature]}>
    {/* The live `Field` row: `flex-col` turned into this row. */}
    <div className="flex flex-row items-center gap-2">
      <CheckboxFace />
      <LabelFace>
        <PendingText barClassName="w-28" id={BETA_FEATURES[feature].title} />
      </LabelFace>
    </div>
  </BetaFeaturePanel>
);

/** The self-serve previews while their enrolment loads. */
export const SelfServeFeaturePanelsPending = () => (
  <>
    <BetaFeaturePanelPending feature="timeBilling" />
    <BetaFeaturePanelPending feature="localAgents" />
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
    <Frame>
      {workflows}
      {selfServe}
      {inbox}
    </Frame>
  </>
);

const BetaPendingView = () => (
  <SettingsPagePending>
    <BetaPageShell
      inbox={<BetaFeaturePanelPending feature="inbox" />}
      selfServe={<SelfServeFeaturePanelsPending />}
      workflows={<BetaFeaturePanelPending feature="workflows" />}
    />
  </SettingsPagePending>
);

export const BetaPending = framePendingView(BetaPendingView);
