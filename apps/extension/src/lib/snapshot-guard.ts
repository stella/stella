import { panic } from "better-result";

import {
  BROWSER_CONTROL_ACTION,
  type BrowserControlCommand,
  type BrowserObservedTab,
  parseElementReference,
} from "@stll/api-contract/browser-control";

/** The latest snapshot of the controlled tab, as the extension read it. */
export type SnapshotState = {
  /** Chrome's document id for each frame read, keyed by frame id. */
  documents: Record<string, string>;
  revision: string;
  tabId: number;
  url: string;
};

type IdentityVerdict =
  /** `documentId` is the document an element command must act in. */
  | { documentId: string | null; status: "ok" }
  | { status: "stale-snapshot" }
  | { status: "tab-changed" };

type CommandIdentity = {
  command: BrowserControlCommand;
  /**
   * The tab chat operates now, its current URL, and whether the user handed
   * it over from the popup rather than chat opening it; null when there is
   * none.
   */
  controlledTab: {
    adopted: boolean;
    tabId: number;
    url: string | undefined;
  } | null;
  /** The tab and snapshot the web client last saw a result for. */
  observedTab: BrowserObservedTab | null;
  snapshot: SnapshotState | null;
};

/**
 * Whether a command still addresses what the model saw. A read is always
 * current. A navigation needs the tab the web client last saw; a web client
 * that saw none may only navigate a tab chat opened itself, never one the
 * user handed over. An element command needs the snapshot its refs came
 * from, in the same tab, at the same URL, with the frame's document still
 * the one that was read.
 */
export const checkCommandIdentity = ({
  command,
  controlledTab,
  observedTab,
  snapshot,
}: CommandIdentity): IdentityVerdict => {
  switch (command.action) {
    case BROWSER_CONTROL_ACTION.snapshot:
      return { documentId: null, status: "ok" };
    case BROWSER_CONTROL_ACTION.open:
    case BROWSER_CONTROL_ACTION.goBack:
      if (controlledTab === null) {
        return { documentId: null, status: "ok" };
      }
      if (
        observedTab === null
          ? controlledTab.adopted
          : observedTab.tabId !== controlledTab.tabId
      ) {
        return { status: "tab-changed" };
      }
      // Going back from a newer snapshot than the one the web client saw
      // leads somewhere the model did not choose.
      return command.action === BROWSER_CONTROL_ACTION.goBack &&
        observedTab !== null &&
        snapshot !== null &&
        snapshot.revision !== observedTab.revision
        ? { status: "stale-snapshot" }
        : { documentId: null, status: "ok" };
    case BROWSER_CONTROL_ACTION.click:
    case BROWSER_CONTROL_ACTION.fill:
    case BROWSER_CONTROL_ACTION.pressKey:
    case BROWSER_CONTROL_ACTION.select: {
      if (controlledTab === null) {
        return { status: "stale-snapshot" };
      }
      if (observedTab !== null && observedTab.tabId !== controlledTab.tabId) {
        return { status: "tab-changed" };
      }
      const reference = parseElementReference(command.target.ref);
      const documentId =
        reference === null
          ? undefined
          : snapshot?.documents[String(reference.frameId)];
      if (
        snapshot === null ||
        documentId === undefined ||
        snapshot.tabId !== controlledTab.tabId ||
        snapshot.revision !== command.page.revision ||
        snapshot.url !== command.page.url ||
        controlledTab.url !== command.page.url
      ) {
        return { status: "stale-snapshot" };
      }
      return { documentId, status: "ok" };
    }
    default:
      command satisfies never;
      return panic("Unhandled browser command action");
  }
};
