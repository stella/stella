import { Result } from "better-result";

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

export const createTargets = (client: CdpClient) => {
  const chats = new Map<string, ChatTabs>();
  const byTarget = new Map<string, OwnedTab>();
  /** Every session a chat's tab holds, its frames' too. */
  const bySession = new Map<string, OwnedTab>();
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
  // A window a chat's page opens is the chat's: closed with its tabs.
  client.on("Target.targetCreated", ({ targetInfo }) => {
    const opener =
      targetInfo.openerId === undefined
        ? undefined
        : byTarget.get(targetInfo.openerId);
    if (opener !== undefined) {
      chatOf(opener.controllerId).popups.add(targetInfo.targetId);
    }
  });
  // A frame in another process attaches on its parent's session.
  client.on("Target.attachedToTarget", ({ sessionId, targetInfo }, parent) => {
    const tab = parent === null ? undefined : bySession.get(parent);
    if (tab === undefined || targetInfo.type !== "iframe") {
      return;
    }
    tab.frameSessions.set(targetInfo.targetId, sessionId);
    bySession.set(sessionId, tab);
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

  const closeTarget = async (targetId: string) => {
    const closed = await client.send("Target.closeTarget", { targetId });
    if (Result.isError(closed)) {
      // Gone already, or the browser is: nothing is left to close.
      forget(targetId);
    }
  };

  /**
   * A new window for the chat, blank, in the background, with its frames
   * in other processes attached as they appear; why not, when the browser
   * would not make one.
   */
  const openTab = async (
    controllerId: string,
    signal: AbortSignal,
  ): Promise<Result<OwnedTab, CdpFailure>> => {
    const created = await client.send(
      "Target.createTarget",
      { background: true, newWindow: true, url: "about:blank" },
      { signal },
    );
    if (Result.isError(created)) {
      return created;
    }
    const { targetId } = created.value;
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
      ? await client.send(
          "Target.setAutoAttach",
          { autoAttach: true, flatten: true, waitForDebuggerOnStart: false },
          { sessionId, signal },
        )
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
    /** The tab the chat reads: the one it opened last that is still open. */
    activeTab: (controllerId: string): OwnedTab | null =>
      chats.get(controllerId)?.tabs.at(-1) ?? null,
    /** The chat's tabs, the active one first, then the others newest first. */
    chatTabs: (controllerId: string): OwnedTab[] =>
      (chats.get(controllerId)?.tabs ?? []).toReversed(),
    /** Closes every tab and window of the chat; true when no chat has any left. */
    releaseChat: async (controllerId: string): Promise<boolean> => {
      const chat = chats.get(controllerId);
      chats.delete(controllerId);
      if (chat !== undefined) {
        for (const targetId of [
          ...chat.tabs.map((tab) => tab.targetId),
          ...chat.popups,
        ]) {
          await closeTarget(targetId);
        }
      }
      return [...chats.values()].every(({ tabs }) => tabs.length === 0);
    },
    /** Whether any chat still has a tab. */
    holdsTabs: () => [...chats.values()].some(({ tabs }) => tabs.length > 0),
  };
};

export type Targets = ReturnType<typeof createTargets>;
