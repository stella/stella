import { describe, expect, test } from "bun:test";

import {
  nextSidePanelChatStatus,
  SIDE_PANEL_CHAT_STATUS,
} from "@/components/chat/side-panel-chat-status.logic";
import type {
  SidePanelChatEvent,
  SidePanelChatStatus,
} from "@/components/chat/side-panel-chat-status.logic";

const { creating, idle, ready } = SIDE_PANEL_CHAT_STATUS;

const replay = (events: readonly SidePanelChatEvent[]) => {
  let status: SidePanelChatStatus = idle;
  for (const event of events) {
    status = nextSidePanelChatStatus(status, event);
  }
  return status;
};

describe("nextSidePanelChatStatus", () => {
  test("a fork waits, confirms, then settles back", () => {
    expect(replay(["start"])).toBe(creating);
    expect(replay(["start", "opened"])).toBe(ready);
    expect(replay(["start", "opened", "settled"])).toBe(idle);
  });

  test("a chat that opens at once confirms without waiting", () => {
    expect(replay(["opened"])).toBe(ready);
  });

  test("a failure drops the wait and leaves the error to the caller", () => {
    expect(replay(["start", "failed"])).toBe(idle);
  });

  test("a stale timer does not cut short a newer request", () => {
    expect(replay(["opened", "start", "settled"])).toBe(creating);
  });

  test("a failure elsewhere does not hide a confirmation on screen", () => {
    expect(replay(["opened", "failed"])).toBe(ready);
  });

  test("asking again while confirming starts over", () => {
    expect(replay(["opened", "start"])).toBe(creating);
    expect(replay(["opened", "opened"])).toBe(ready);
  });
});
