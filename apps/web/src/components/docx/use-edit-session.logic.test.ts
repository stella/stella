import { describe, expect, test } from "bun:test";

import {
  resolveEditSessionFailure,
  resolveTakenOverSession,
} from "./use-edit-session.logic";

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
