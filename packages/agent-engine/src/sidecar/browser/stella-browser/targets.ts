import { panic, Result } from "better-result";

import { BROWSER_CONTROL_LIMITS } from "@stll/api-contract/browser-control";

import type { CdpClient, CdpFailure } from "./cdp-client";

/**
 * Which of the stella browser's tabs belong to which chat. A chat's first
 * `open` creates a window of its own; only tabs a chat created are its,
 * and a tab the member opens is no chat's and invisible to every chat.
 * Tabs get small numbers, since the contract's tab id is a number, and the
 * frames in each get numbers too, the top frame 0, so element refs keep
 * their `e:<frame>:<path>` form.
 */

export type OwnedTab = {
  tabId: number;
  controllerId: string;
  targetId: string;
  /** The tab's page session: the top frame and the frames in its process. */
  sessionId: string;
  /** Its address as the browser last reported it. */
  url: string;
  /** Frames in other processes, by frame id, with their own sessions. */
  frameSessions: Map<string, string>;
  /** Frame numbers by frame id; the top frame is 0. */
  frameNumbers: Map<string, number>;
  nextFrameNumber: number;
};

type ChatTabs = {
  /** Oldest first; the last opened is the one the chat reads. */
  tabs: OwnedTab[];
  /** Windows the chat's pages opened: not readable yet, closed with the chat. */
  popups: Set<string>;
};

export const TOP_FRAME_NUMBER = 0;

/** The frame's number in its tab: 0 for the top frame, then in the order frames are met. */
export const frameNumberOf = (tab: OwnedTab, frameId: string): number => {
  if (frameId === tab.targetId) {
    return TOP_FRAME_NUMBER;
  }
  const known = tab.frameNumbers.get(frameId);
  if (known !== undefined) {
    return known;
  }
  const assigned = tab.nextFrameNumber;
  tab.nextFrameNumber += 1;
  tab.frameNumbers.set(frameId, assigned);
  return assigned;
};

/** Frames in other processes attach as they appear, flattened onto one pipe. */
const AUTO_ATTACH = {
  autoAttach: true,
  flatten: true,
  waitForDebuggerOnStart: false,
} as const;

/**
 * Whether a failed close leaves nothing open: the browser says it has no
 * such window, or the browser is gone. Without an answer it can read, the
 * holder cannot tell.
 */
const closeLeftNothing = (failure: CdpFailure): boolean => {
  switch (failure.type) {
    case "protocol":
    case "disconnected":
      return true;
    case "timeout":
    case "invalid":
    case "aborted":
    case "refused":
      return false;
    default:
      failure satisfies never;
      return panic("Unhandled protocol failure");
  }
};

export const createTargets = (
  client: CdpClient,
  /** Runs work nobody waits for, reporting a rejection. */
  background: (work: Promise<unknown>, task: `${string}.${string}`) => void,
) => {
  const chats = new Map<string, ChatTabs>();
  const byTarget = new Map<string, OwnedTab>();
  /** Every session a chat's tab holds, its frames' too. */
  const bySession = new Map<string, OwnedTab>();
  /**
   * Windows asked to close that the browser neither closed nor said were
   * gone (no answer in time, or one the holder could not read): asked
   * again on the next release.
   */
  const unclosed = new Set<string>();
  let nextTabId = 1;

  const chatOf = (controllerId: string): ChatTabs => {
    const existing = chats.get(controllerId);
    if (existing !== undefined) {
      return existing;
    }
    const created: ChatTabs = { popups: new Set(), tabs: [] };
    chats.set(controllerId, created);
    return created;
  };

  const forget = (targetId: string) => {
    unclosed.delete(targetId);
    const tab = byTarget.get(targetId);
    for (const chat of chats.values()) {
      chat.popups.delete(targetId);
    }
    if (tab === undefined) {
      return;
    }
    byTarget.delete(targetId);
    bySession.delete(tab.sessionId);
    for (const sessionId of tab.frameSessions.values()) {
      bySession.delete(sessionId);
    }
    const chat = chats.get(tab.controllerId);
    if (chat !== undefined) {
      chat.tabs = chat.tabs.filter((owned) => owned !== tab);
    }
  };

  /**
   * Asks the browser to close a window. A window it closes is forgotten
   * when it reports it destroyed; one it says it does not have, or a
   * browser that is gone, leaves nothing to close; any other failure leaves
   * the window possibly open, and it is asked again on the next release.
   */
  const closeTarget = async (targetId: string) => {
    const closed = await client.send("Target.closeTarget", { targetId });
    if (Result.isOk(closed)) {
      unclosed.delete(targetId);
    } else if (closeLeftNothing(closed.error)) {
      forget(targetId);
    } else {
      unclosed.add(targetId);
    }
  };

  client.on("Target.targetDestroyed", ({ targetId }) => {
    forget(targetId);
  });
  client.on("Target.targetCrashed", ({ targetId }) => {
    forget(targetId);
  });
  client.on("Target.targetInfoChanged", ({ targetInfo }) => {
    const tab = byTarget.get(targetInfo.targetId);
    if (tab !== undefined) {
      tab.url = targetInfo.url;
    }
  });
  // A window a chat's page opens is the chat's: closed with its tabs, and
  // counted with them, so one past the chat's tab limit closes at once. One
  // a page opens without an opener (`noopener`) carries no opener id, so it
  // is no chat's, like a tab the member opens: never listed or read, and
  // left open (a known limit until tab ownership follows the opening frame).
  client.on("Target.targetCreated", ({ targetInfo }) => {
    const opener =
      targetInfo.openerId === undefined
        ? undefined
        : byTarget.get(targetInfo.openerId);
    if (opener === undefined) {
      return;
    }
    const chat = chatOf(opener.controllerId);
    if (chat.tabs.length + chat.popups.size >= BROWSER_CONTROL_LIMITS.tabs) {
      background(
        closeTarget(targetInfo.targetId).then(() => true),
        "stella-browser.close-window-over-limit",
      );
      return;
    }
    chat.popups.add(targetInfo.targetId);
  });
  // A frame in another process attaches on its parent's session, and the
  // frames inside it attach on its own once it auto-attaches as well.
  client.on("Target.attachedToTarget", ({ sessionId, targetInfo }, parent) => {
    const tab = parent === null ? undefined : bySession.get(parent);
    if (tab === undefined || targetInfo.type !== "iframe") {
      return;
    }
    tab.frameSessions.set(targetInfo.targetId, sessionId);
    bySession.set(sessionId, tab);
    background(
      client
        .send("Target.setAutoAttach", AUTO_ATTACH, { sessionId })
        // A frame that went before it could attach has nothing nested left.
        .then((attached) => Result.isOk(attached)),
      "stella-browser.frame-auto-attach",
    );
  });
  client.on("Target.detachedFromTarget", ({ sessionId }) => {
    const tab = bySession.get(sessionId);
    if (tab === undefined || tab.sessionId === sessionId) {
      return;
    }
    bySession.delete(sessionId);
    for (const [frameId, frameSession] of tab.frameSessions) {
      if (frameSession === sessionId) {
        tab.frameSessions.delete(frameId);
      }
    }
  });

  /**
   * A new window for the chat, blank, in the background, with its frames
   * in other processes attached as they appear; why not, when the browser
   * would not make one. The window is waited for even when `signal` aborts
   * meanwhile, since the browser makes it once asked: a stopped or released
   * open closes the window it made instead of leaving it behind.
   */
  const openTab = async (
    controllerId: string,
    signal: AbortSignal,
  ): Promise<Result<OwnedTab, CdpFailure>> => {
    const created = await client.send("Target.createTarget", {
      background: true,
      newWindow: true,
      url: "about:blank",
    });
    if (Result.isError(created)) {
      return created;
    }
    const { targetId } = created.value;
    if (signal.aborted) {
      await closeTarget(targetId);
      return Result.err({ type: "aborted" });
    }
    const attached = await client.send(
      "Target.attachToTarget",
      { flatten: true, targetId },
      { signal },
    );
    if (Result.isError(attached)) {
      await closeTarget(targetId);
      return attached;
    }
    const tab: OwnedTab = {
      controllerId,
      frameNumbers: new Map(),
      frameSessions: new Map(),
      nextFrameNumber: TOP_FRAME_NUMBER + 1,
      sessionId: attached.value.sessionId,
      tabId: nextTabId,
      targetId,
      url: "about:blank",
    };
    nextTabId += 1;
    byTarget.set(targetId, tab);
    bySession.set(tab.sessionId, tab);
    chatOf(controllerId).tabs.push(tab);
    const sessionId = tab.sessionId;
    const enabled = await client.send("Page.enable", {}, { sessionId, signal });
    const framesAttach = Result.isOk(enabled)
      ? await client.send("Target.setAutoAttach", AUTO_ATTACH, {
          sessionId,
          signal,
        })
      : enabled;
    if (Result.isError(framesAttach)) {
      await closeTarget(targetId);
      forget(targetId);
      return framesAttach;
    }
    return Result.ok(tab);
  };

  return {
    openTab,
    /**
     * Brings the chat's tab and its window to the front, where the member
     * signs in; false when the chat has none or the browser would not.
     */
    showTab: async (controllerId: string): Promise<boolean> => {
      const tab = chats.get(controllerId)?.tabs.at(-1);
      if (tab === undefined) {
        return false;
      }
      const shown = await client.send("Target.activateTarget", {
        targetId: tab.targetId,
      });
      return Result.isOk(shown);
    },
    /** The tab the chat reads: the one it opened last that is still open. */
    activeTab: (controllerId: string): OwnedTab | null =>
      chats.get(controllerId)?.tabs.at(-1) ?? null,
    /** The chat's tabs, the active one first, then the others newest first. */
    chatTabs: (controllerId: string): OwnedTab[] =>
      (chats.get(controllerId)?.tabs ?? []).toReversed(),
    /** The chat's tabs and the windows its pages opened, which its tab limit counts. */
    windowCount: (controllerId: string): number => {
      const chat = chats.get(controllerId);
      return chat === undefined ? 0 : chat.tabs.length + chat.popups.size;
    },
    /**
     * Closes every tab and window of the chat, and asks again for those an
     * earlier close left uncertain; true when no chat has a tab left.
     */
    releaseChat: async (controllerId: string): Promise<boolean> => {
      const chat = chats.get(controllerId);
      chats.delete(controllerId);
      const leftOpen = [...unclosed];
      for (const targetId of [
        ...(chat?.tabs.map((tab) => tab.targetId) ?? []),
        ...(chat?.popups ?? []),
        ...leftOpen,
      ]) {
        await closeTarget(targetId);
      }
      return [...chats.values()].every(({ tabs }) => tabs.length === 0);
    },
    /** Whether any chat still has a tab. */
    holdsTabs: () => [...chats.values()].some(({ tabs }) => tabs.length > 0),
  };
};

export type Targets = ReturnType<typeof createTargets>;
