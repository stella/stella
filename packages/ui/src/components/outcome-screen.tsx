import { useEffect } from "react";

import { useLatest } from "../hooks/use-latest";
import { OutcomeScreenView } from "./outcome-screen-view";
import type { OutcomeScreenViewProps } from "./outcome-screen-view";

// The one screen a flow ends on: "ChatGPT is connected", "Signed in",
// "Invitation declined". Every such flow fills this design with its own words
// (`no-adhoc-outcome-screen` rejects any other). Pages a local loopback server
// answers cannot run React, so `scripts/generate-outcome-page.ts` renders the
// same markup (./outcome-screen-view.tsx) into a self-contained HTML template
// they fill in.

/** How long a tab that asked to close waits before it counts as still open. */
const CLOSE_FALLBACK_MS = 150;

export type OutcomeCloseTab = {
  /** Runs before the tab closes, e.g. to tell the opener what happened. */
  onBeforeClose?: () => void;
  /**
   * Runs when the browser kept the tab open (it only closes tabs a script
   * opened), so the member is taken somewhere useful instead of stranded.
   */
  onStillOpen: () => void;
};

type OutcomeScreenProps = OutcomeScreenViewProps & {
  /** Close the tab once shown; see `OutcomeCloseTab`. */
  closeTab?: OutcomeCloseTab;
};

/** Closes the tab once shown, and reports when the browser kept it open. */
const useCloseTab = (closeTab: OutcomeCloseTab | undefined) => {
  // Read through a ref so a parent re-render cannot close the tab twice.
  const latest = useLatest(closeTab);
  const wantsClose = closeTab !== undefined;
  useEffect(() => {
    const request = wantsClose ? latest.current : undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    if (request !== undefined) {
      request.onBeforeClose?.();
      window.close();
      fallback = setTimeout(() => {
        latest.current?.onStillOpen();
      }, CLOSE_FALLBACK_MS);
    }
    return () => clearTimeout(fallback);
  }, [latest, wantsClose]);
};

export const OutcomeScreen = ({ closeTab, ...view }: OutcomeScreenProps) => {
  useCloseTab(closeTab);
  return <OutcomeScreenView {...view} />;
};
