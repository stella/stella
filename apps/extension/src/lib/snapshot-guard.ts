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

/**
 * The top document of the controlled tab: Chrome's document id (null when
 * the page cannot be scripted, such as an error page) and the tab URL (null
 * when Chrome does not show it).
 */
export type TopDocument = {
  documentId: string | null;
  url: string | null;
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
  /**
   * For `open` and `go-back`: the tab's top document now, and the one chat
   * last saw in a successful read. Failed and stopped commands do not
   * change what chat saw.
   */
  navigation?: { live: TopDocument; settled: TopDocument | null };
  /** The tab and snapshot the web client last saw a result for. */
  observedTab: BrowserObservedTab | null;
  snapshot: SnapshotState | null;
};

const sameDocument = (left: TopDocument, right: TopDocument): boolean =>
  left.documentId === right.documentId && left.url === right.url;

/**
 * Whether the tab still shows the page chat last read. A page that cannot
 * be read (an error page, a blocked address) holds nothing to lose; chat
 * may navigate away from it.
 */
const navigationMatchesSeenPage = (
  navigation: CommandIdentity["navigation"],
): boolean => {
  if (navigation === undefined) {
    return true;
  }
  const { live, settled } = navigation;
  return (
    live.documentId === null || settled === null || sameDocument(live, settled)
  );
};

/**
 * Whether a command still addresses what the model saw. A read is always
 * current. A navigation needs the tab the web client last saw, still showing
 * the document the last command ended on, so a page the user opened or
 * reloaded in between is not navigated away; a web client that saw no tab
 * may only navigate a tab chat opened itself, never one the user handed
 * over. Going back also needs the snapshot the web client saw, since where
 * it leads depends on the page. An element command needs the snapshot its
 * refs came from, in the same tab, at the same URL, with the frame's
 * document still the one that was read.
 */
export const checkCommandIdentity = ({
  command,
  controlledTab,
  navigation,
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
      if (
        observedTab !== null &&
        snapshot !== null &&
        snapshot.revision !== observedTab.revision
      ) {
        return { status: "stale-snapshot" };
      }
      if (
        command.action === BROWSER_CONTROL_ACTION.goBack &&
        (snapshot === null || observedTab === null)
      ) {
        return { status: "stale-snapshot" };
      }
      return navigationMatchesSeenPage(navigation)
        ? { documentId: null, status: "ok" }
        : { status: "stale-snapshot" };
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
