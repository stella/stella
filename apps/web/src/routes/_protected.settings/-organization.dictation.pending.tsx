import type { ReactNode } from "react";

import {
  List,
  ListGroup,
  ListGroupDescription,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListItemSkeleton,
} from "@stll/ui/list-shell";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeaderPending } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";

/** The dictation page's layout, in both phases: heading, the word list. */
export const DictationPageShell = ({
  children,
}: {
  /** The word list. */
  children: ReactNode;
}) => (
  <>
    <SettingsPageHeaderPending
      description="settings.organization.dictation.description"
      title="settings.organization.dictation.title"
    />
    {children}
  </>
);

const ROW_KEYS = [{ key: "a" }, { key: "b" }, { key: "c" }] as const;

/** The word list while it loads: its real heading over placeholder rows. */
const DictationVocabularyPending = () => (
  <ListGroup>
    <ListGroupHeader>
      <ListGroupHeading>
        <ListGroupTitle>
          <PendingText
            barClassName="w-28"
            id="settings.organization.dictation.wordsTitle"
          />
        </ListGroupTitle>
        <ListGroupDescription>
          <PendingText
            barClassName="w-72 max-w-full"
            id="settings.organization.dictation.wordsDescription"
          />
        </ListGroupDescription>
      </ListGroupHeading>
    </ListGroupHeader>
    <List aria-hidden="true">
      {ROW_KEYS.map((row, index) => (
        <ListItemSkeleton index={index} key={row.key} />
      ))}
    </List>
  </ListGroup>
);

const DictationPendingView = () => (
  <SettingsPagePending area="organization">
    <DictationPageShell>
      <DictationVocabularyPending />
    </DictationPageShell>
  </SettingsPagePending>
);

export const DictationPending = framePendingView(DictationPendingView);
