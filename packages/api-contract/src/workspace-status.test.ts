import { describe, expect, test } from "bun:test";

import {
  VISIBLE_WORKSPACE_STATUSES,
  WORKSPACE_STATUS,
  WORKSPACE_STATUSES,
  workspaceAcceptsWrites,
  workspaceIsVisible,
} from "./workspace-status";

describe("workspace status domain", () => {
  test("the statuses tuple lists every status constant once", () => {
    expect([...WORKSPACE_STATUSES].toSorted()).toEqual(
      Object.values(WORKSPACE_STATUS).toSorted(),
    );
  });

  test("a deleting workspace is the only hidden one", () => {
    expect(VISIBLE_WORKSPACE_STATUSES).toEqual([
      WORKSPACE_STATUS.active,
      WORKSPACE_STATUS.archived,
    ]);
    for (const status of WORKSPACE_STATUSES) {
      expect(workspaceIsVisible(status)).toBe(
        status !== WORKSPACE_STATUS.deleting,
      );
    }
  });

  test("only an active workspace accepts writes", () => {
    for (const status of WORKSPACE_STATUSES) {
      expect(workspaceAcceptsWrites(status)).toBe(
        status === WORKSPACE_STATUS.active,
      );
    }
    expect(workspaceAcceptsWrites(null)).toBe(false);
    expect(workspaceAcceptsWrites(undefined)).toBe(false);
  });

  test("an absent workspace is not visible", () => {
    expect(workspaceIsVisible(null)).toBe(false);
    expect(workspaceIsVisible(undefined)).toBe(false);
  });
});
