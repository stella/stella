import type { ReactNode } from "react";

import {
  ActivityIcon,
  CaseLawIcon,
  HistoryIcon,
  LandmarkIcon,
} from "@stll/ui/icons";
import {
  LANDING_SECTION_HEADING_CLASS,
  LandingBoxPending,
  LandingGreeting,
  LandingLayout,
  LandingRowsPending,
  LandingSection,
} from "@stll/ui/landing-shell";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

/** The top courts column heading's label; the loaded page makes it a link. */
export const LawHomeTopCourtsLabel = () => (
  <>
    <LandmarkIcon className="size-4" />
    <PendingText barClassName="w-20" id="lawHome.topCourts" />
  </>
);

/** The signals column heading's label; a link where statutes exist. */
export const LawHomeSignalsLabel = () => (
  <>
    <ActivityIcon className="size-4" />
    <PendingText barClassName="w-16" id="lawHome.signals" />
  </>
);

type LawHomeColumn = {
  heading: ReactNode;
  rows: ReactNode;
};

type LawHomeShellProps = {
  /** The pending phase: the layout stands in for the page. */
  placeholder?: boolean | undefined;
  /** The entry box under the greeting. */
  entry: ReactNode;
  topCourts: LawHomeColumn;
  signals: LawHomeColumn;
  /** The recent searches column, a whole section: it owns its controls. */
  recent: ReactNode;
};

/**
 * The law home's one layout, drawn by both phases: the section's mark and
 * question over the entry box, then the top courts, signals and recent
 * columns. The loaded page fills the slots with the box, linked headings
 * and rows; the pending phase with the box and rows still to come.
 */
export const LawHomeShell = ({
  entry,
  recent,
  signals,
  topCourts,
  placeholder = false,
}: LawHomeShellProps) => (
  <LandingLayout
    placeholder={placeholder}
    hero={
      <>
        <LandingGreeting icon={<CaseLawIcon className="size-6" />}>
          <PendingText barClassName="w-56" id="lawHome.prompt" />
        </LandingGreeting>
        {entry}
      </>
    }
  >
    <LandingSection heading={topCourts.heading}>
      {topCourts.rows}
    </LandingSection>
    <LandingSection heading={signals.heading}>{signals.rows}</LandingSection>
    {recent}
  </LandingLayout>
);

/** The law home in its pending phase. */
const LawHomePendingView = () => (
  <LawHomeShell
    placeholder
    entry={<LandingBoxPending box="search" />}
    recent={
      <LandingSection
        heading={
          <span className={LANDING_SECTION_HEADING_CLASS}>
            <HistoryIcon className="size-4" />
            <PendingText barClassName="w-16" id="lawHome.recent" />
          </span>
        }
      >
        <LandingRowsPending />
      </LandingSection>
    }
    signals={{
      heading: (
        <span className={LANDING_SECTION_HEADING_CLASS}>
          <LawHomeSignalsLabel />
        </span>
      ),
      rows: <LandingRowsPending />,
    }}
    topCourts={{
      heading: (
        <span className={LANDING_SECTION_HEADING_CLASS}>
          <LawHomeTopCourtsLabel />
        </span>
      ),
      rows: <LandingRowsPending />,
    }}
  />
);

export const LawHomePending = framePendingView(LawHomePendingView);
