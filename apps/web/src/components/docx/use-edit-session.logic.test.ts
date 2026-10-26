import { describe, expect, test } from "bun:test";

import { toAPIError } from "@/lib/errors/api";

import {
  checkpointLeaveAction,
  resolveEditSessionFailure,
  resolveTakenOverSession,
} from "./use-edit-session.logic";

describe("leaving after the final checkpoint", () => {
  test("a saved checkpoint goes on to finalize", () => {
    expect(checkpointLeaveAction({ type: "saved" })).toEqual({
      type: "finalize",
    });
  });

  test("no session to save into closes without an error", () => {
    expect(checkpointLeaveAction({ type: "noSession" })).toEqual({
      type: "close",
    });
  });

  test("a released session stays behind its banner without an error", () => {
    expect(checkpointLeaveAction({ type: "released" })).toEqual({
      type: "stay",
    });
  });

  test("a refused or unreachable checkpoint is reported with its cause", () => {
    const refused = toAPIError({ status: 500, value: { message: "boom" } });
    const unreachable = new TypeError("Failed to fetch");

    expect(checkpointLeaveAction({ type: "refused", error: refused })).toEqual({
      type: "report",
      error: refused,
    });
    expect(
      checkpointLeaveAction({ type: "unreachable", error: unreachable }),
    ).toEqual({ type: "report", error: unreachable });
  });
});

describe("edit session take-over", () => {
  test("a conflict on open releases the session instead of failing it", () => {
    expect(
      resolveEditSessionFailure({
        detail: "Desktop editing moved to another device.",
        hasUnsavedChanges: false,
        source: "open",
        status: 409,
      }),
    ).toEqual({
      status: "released",
      reason: "takenOver",
      hasUnsavedChanges: false,
    });
  });

  test("a conflict on checkpoint releases the session with the unsaved work", () => {
    expect(
      resolveTakenOverSession({ hasUnsavedChanges: true, status: 409 }),
    ).toEqual({
      status: "released",
      reason: "takenOver",
      hasUnsavedChanges: true,
    });
  });

  test("a conflict on finalize releases the session", () => {
    expect(
      resolveEditSessionFailure({
        detail: "Failed to save DOCX.",
        hasUnsavedChanges: true,
        source: "finalize",
        status: 409,
      }),
    ).toEqual({
      status: "released",
      reason: "takenOver",
      hasUnsavedChanges: true,
    });
  });

  test("leaves every other checkpoint failure to the autosave status", () => {
    expect(
      resolveTakenOverSession({ hasUnsavedChanges: true, status: 500 }),
    ).toBeNull();
  });
});

describe("edit session failures", () => {
  test("keeps auth, permission and unknown failures as errors", () => {
    expect(
      resolveEditSessionFailure({
        detail: undefined,
        hasUnsavedChanges: false,
        source: "open",
        status: 401,
      }),
    ).toEqual({
      status: "error",
      reason: "authRequired",
      source: "open",
      detail: undefined,
    });
    expect(
      resolveEditSessionFailure({
        detail: undefined,
        hasUnsavedChanges: false,
        source: "open",
        status: 403,
      }),
    ).toEqual({
      status: "error",
      reason: "permissionDenied",
      source: "open",
      detail: undefined,
    });
    expect(
      resolveEditSessionFailure({
        detail: "Failed to save DOCX.",
        hasUnsavedChanges: true,
        source: "finalize",
        status: 500,
      }),
    ).toEqual({
      status: "error",
      reason: "unknown",
      source: "finalize",
      detail: "Failed to save DOCX.",
    });
  });
});
