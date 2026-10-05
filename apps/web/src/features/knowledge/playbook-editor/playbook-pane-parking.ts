import { create } from "zustand";

import type {
  PlaybookBaseline,
  PlaybookDraft,
} from "@/features/knowledge/playbook-editor/playbook-editor.logic";
import type { PlaybookApprovalStatus } from "@/lib/knowledge/playbook-types";

/**
 * An inspector view renders only while its tab is active and the pane is
 * expanded, so the pane editor unmounts whenever the user opens another tab
 * or minimizes the pane. Its state is parked here on unmount and restored on
 * the next mount, so leaving the tab loses nothing that a save could not
 * keep: an invalid draft, or unsaved edits to an approved playbook.
 *
 * The draft, its baseline and its token are parked together, so a restored
 * token is never paired with a different draft. In memory only: a reload
 * starts from the server.
 */
export type ParkedPlaybookPane = {
  playbookId: string;
  draft: PlaybookDraft;
  updatedAt: string | null;
  baseline: PlaybookBaseline;
  status: PlaybookApprovalStatus;
  approvedAt: string | null;
  openIds: ReadonlySet<string>;
  revealedIds: ReadonlySet<string>;
  scrollTop: number;
};

const useParkedPlaybookPanes = create<
  Readonly<Record<string, ParkedPlaybookPane>>
>(() => ({}));

type ParkPlaybookPaneArgs = {
  tabId: string;
  state: ParkedPlaybookPane;
  /** Entries of tabs closed while their editor was not mounted are dropped. */
  isTabOpen: (tabId: string) => boolean;
};

export const parkPlaybookPane = ({
  tabId,
  state,
  isTabOpen,
}: ParkPlaybookPaneArgs) => {
  useParkedPlaybookPanes.setState(
    (current) => ({
      ...Object.fromEntries(
        Object.entries(current).filter(([id]) => isTabOpen(id)),
      ),
      [tabId]: state,
    }),
    true,
  );
};

/** The state parked for this tab, if it was parked for the same playbook. */
export const readParkedPlaybookPane = (
  tabId: string,
  playbookId: string,
): ParkedPlaybookPane | null => {
  const entry = useParkedPlaybookPanes.getState()[tabId];
  return entry?.playbookId === playbookId ? entry : null;
};

export const discardParkedPlaybookPane = (tabId: string) => {
  useParkedPlaybookPanes.setState(
    (current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => id !== tabId),
      ),
    true,
  );
};
