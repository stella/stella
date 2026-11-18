import type { ReactNode } from "react";

import { HistoryIcon, SkillIcon } from "@stll/ui/icons";
import {
  LANDING_SECTION_HEADING_CLASS,
  LandingBoxPending,
  LandingGreeting,
  LandingLayout,
  LandingRowsPending,
  LandingSection,
  LandingSectionHeadingPending,
} from "@stll/ui/landing-shell";
import { StellaMark } from "@stll/ui/stella-mark";

import { PendingText } from "@/components/pending-text";

/** The skills column heading's label; the loaded page makes it a link. */
export const ChatLandingSkillsLabel = () => (
  <>
    <SkillIcon className="size-4" />
    <PendingText barClassName="w-12" id="chat.landing.skills" />
  </>
);

/** The recent chats column heading's label; the loaded page makes it a link. */
export const ChatLandingRecentChatsLabel = () => (
  <>
    <HistoryIcon className="size-4" />
    <PendingText barClassName="w-24" id="chat.landing.recentChats" />
  </>
);

type ChatLandingColumn = {
  /** The column's heading; the pending phase shows its static label. */
  heading: ReactNode;
  rows: ReactNode;
};

type ChatIndexShellProps = {
  /** The pending phase: the layout stands in for the page. */
  placeholder?: boolean | undefined;
  /** The box under the greeting: the large composer. */
  composer: ReactNode;
  matters: ChatLandingColumn;
  skills: ChatLandingColumn;
  recentChats: ChatLandingColumn;
};

/**
 * The chat home's one layout, drawn by both phases: the greeting over the
 * composer, then the matters, skills and recent chats columns. The loaded
 * page fills the slots with the composer, linked headings and rows; the
 * pending phase with the box and rows still to come.
 */
export const ChatIndexShell = ({
  composer,
  matters,
  recentChats,
  skills,
  placeholder = false,
}: ChatIndexShellProps) => (
  // No header actions: an empty chat has nothing to move to the side, and
  // the "Recent chats" heading below already opens the history.
  <LandingLayout
    placeholder={placeholder}
    hero={
      <>
        <LandingGreeting icon={<StellaMark className="size-7" />}>
          <PendingText barClassName="w-56" id="chat.greeting" />
        </LandingGreeting>
        <div className="w-full">{composer}</div>
      </>
    }
  >
    <LandingSection heading={matters.heading}>{matters.rows}</LandingSection>
    <LandingSection heading={skills.heading}>{skills.rows}</LandingSection>
    <LandingSection heading={recentChats.heading}>
      {recentChats.rows}
    </LandingSection>
  </LandingLayout>
);

/**
 * The chat home in its pending phase. The matters heading waits as well:
 * whether it reads "pinned" or "last accessed" depends on the member's pins.
 */
export const ChatIndexPending = () => (
  <ChatIndexShell
    placeholder
    composer={<LandingBoxPending box="composer" />}
    matters={{
      heading: <LandingSectionHeadingPending />,
      rows: <LandingRowsPending />,
    }}
    recentChats={{
      heading: (
        <span className={LANDING_SECTION_HEADING_CLASS}>
          <ChatLandingRecentChatsLabel />
        </span>
      ),
      rows: <LandingRowsPending />,
    }}
    skills={{
      heading: (
        <span className={LANDING_SECTION_HEADING_CLASS}>
          <ChatLandingSkillsLabel />
        </span>
      ),
      rows: <LandingRowsPending />,
    }}
  />
);
