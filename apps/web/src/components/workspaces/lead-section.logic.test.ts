import { describe, expect, mock, test } from "bun:test";

import { queryView } from "@/lib/query-view.logic";

import { leadSectionContent } from "./lead-section.logic";

const readError = new Error("Matter read failed");
const retry = mock(async () => {
  throw readError;
});
const workspace = { leadUserId: "member-1" };
const members = [{ userId: "member-1" }];
const workspaceView = queryView({
  status: "success",
  fetchStatus: "idle",
  data: workspace,
  error: null,
  isPlaceholderData: false,
  refetch: retry,
});
const memberView = queryView({
  status: "success",
  fetchStatus: "idle",
  data: members,
  error: null,
  isPlaceholderData: false,
  refetch: retry,
});

describe("matter lead read states", () => {
  test("exposes failed matter and member reads instead of an empty lead", () => {
    const failed = { type: "error", error: readError, retry } as const;
    expect(
      leadSectionContent({ workspace: failed, members: memberView }),
    ).toEqual(failed);
    expect(
      leadSectionContent({ workspace: workspaceView, members: failed }),
    ).toEqual(failed);
  });

  test("waits for both reads before exposing the lead picker", () => {
    expect(
      leadSectionContent({
        workspace: { type: "pending" },
        members: memberView,
      }),
    ).toEqual({ type: "pending" });
    expect(
      leadSectionContent({
        workspace: workspaceView,
        members: { type: "pending" },
      }),
    ).toEqual({ type: "pending" });
  });

  test("uses a successful empty member list as an empty picker", () => {
    expect(
      leadSectionContent({
        workspace: workspaceView,
        members: { type: "empty" },
      }),
    ).toEqual({ type: "items", workspace, members: [] });
  });

  test("retains cached empty members and the refetch failure", () => {
    const cachedMembers = queryView({
      status: "error",
      fetchStatus: "idle",
      data: members.slice(0, 0),
      error: readError,
      isPlaceholderData: false,
      refetch: retry,
    });
    expect(
      leadSectionContent({ workspace: workspaceView, members: cachedMembers }),
    ).toEqual({ type: "items", workspace, members: [] });
    expect(cachedMembers.type === "items" && cachedMembers.refetchError).toBe(
      readError,
    );
  });

  test("retains the lead and members after either cached read fails", () => {
    const cachedWorkspace = queryView({
      status: "error",
      fetchStatus: "idle",
      data: workspace,
      error: readError,
      isPlaceholderData: false,
      refetch: retry,
    });
    const cachedMembers = queryView({
      status: "error",
      fetchStatus: "idle",
      data: members,
      error: readError,
      isPlaceholderData: false,
      refetch: retry,
    });
    expect(
      leadSectionContent({ workspace: cachedWorkspace, members: memberView }),
    ).toEqual({ type: "items", workspace, members });
    expect(
      leadSectionContent({ workspace: workspaceView, members: cachedMembers }),
    ).toEqual({ type: "items", workspace, members });
    expect(
      cachedWorkspace.type === "items" && cachedWorkspace.refetchError,
    ).toBe(readError);
    expect(cachedMembers.type === "items" && cachedMembers.refetchError).toBe(
      readError,
    );
  });
});
