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
 * The top document chat last read: Chrome's document id and the page's URL,
 * both from that one read.
 */
export type TopDocument = {
  documentId: string | null;
  url: string | null;
};

/** The tab's top document now, as Chrome's navigation records report it. */
export type LiveTopDocument = {
  documentId: string;
  url: string;
};

type IdentityVerdict =
  /** `documentId` is the document an element command must act in. */
  | { documentId: string | null; status: "ok" }
  /** A navigation cannot confirm the tab shows the page chat last read. */
  | { status: "page-unconfirmed" }
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
   * For `open` and `go-back`: the tab's top document now (null when Chrome
   * could not say), and the one chat last saw in a successful read. Failed
   * and stopped commands do not change what chat saw.
   */
  navigation?: { live: LiveTopDocument | null; settled: TopDocument | null };
  /** The tab and snapshot the web client last saw a result for. */
  observedTab: BrowserObservedTab | null;
  snapshot: SnapshotState | null;
};

/**
 * Whether chat may navigate the tab away from what it shows now: only the
 * page chat last read successfully. There is no exception for error pages:
 * Chrome documents no signal that identifies its error page and that a
 * failing script injection or an interrupted navigation over a readable
 * page cannot also produce (`webNavigation`'s `errorOccurred` only says the
 * last navigation failed). When Chrome cannot say what the tab shows, or
 * chat has read nothing there, the answer is no, and the user moves the tab
 * on.
 */
const navigationMatchesSeenPage = (
  navigation: CommandIdentity["navigation"],
): boolean => {
  if (navigation === undefined) {
    return true;
  }
  const { live, settled } = navigation;
  return (
    live !== null &&
    settled !== null &&
    settled.documentId === live.documentId &&
    settled.url === live.url
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
        : { status: "page-unconfirmed" };
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
