/**
 * The browser DOCX edit session's state model and the decisions taken on a
 * failed session call. `use-edit-session.ts` owns the requests; this module
 * owns what a response means, so the mapping is testable without a session.
 */

import { panic } from "better-result";

import type { APIError } from "@/lib/errors/api";

/**
 * What a checkpoint did with the bytes it was handed, with the cause when it
 * could not save them. Two are not failures to report: `released` (the lock
 * moved to another tab mid-save, and the released session already says so)
 * and `noSession` (no session is open yet, or any more, so there is nothing
 * to write the bytes to and nothing of the user's is lost).
 */
export type CheckpointOutcome =
  | { type: "saved" }
  | { type: "released" }
  | { type: "noSession" }
  | { type: "refused"; error: APIError }
  | { type: "unreachable"; error: unknown };

/** What leaving the editor does once its final checkpoint has settled. */
export type CheckpointLeaveAction =
  | { type: "finalize" }
  | { type: "close" }
  | { type: "stay" }
  | { type: "report"; error: unknown };

/**
 * `close` leaves without a word, and only when no session means nothing was
 * lost: the user typed nothing here. A session can also vanish because a
 * concurrent checkpoint was taken over while this one serialized; the user's
 * edits then live only on screen, so the document `stay`s behind the released
 * banner, which already explains itself. Only a checkpoint with a cause is
 * reported.
 */
export const checkpointLeaveAction = (
  outcome: CheckpointOutcome,
  { userEdited }: { userEdited: boolean },
): CheckpointLeaveAction => {
  switch (outcome.type) {
    case "saved":
      return { type: "finalize" };
    case "noSession":
      return userEdited ? { type: "stay" } : { type: "close" };
    case "released":
      return { type: "stay" };
    case "refused":
    case "unreachable":
      return { type: "report", error: outcome.error };
    default:
      outcome satisfies never;
      return panic("Unhandled checkpoint outcome");
  }
};

export type EditSessionState =
  | { status: "idle" }
  | { status: "opening" }
  | {
      status: "editing";
      sessionId: string;
      sessionToken: string;
      buffer: ArrayBuffer;
      fileName: string;
    }
  | { status: "saving" }
  | {
      /**
       * Another tab, window or device opened the same document, so the server
       * moved the lock there and released this session. Not an error: the
       * document stays on screen read-only, including whatever this tab has
       * not saved, and reopening takes the session back.
       */
      status: "released";
      reason: "takenOver";
      hasUnsavedChanges: boolean;
    }
  | {
      status: "error";
      reason: EditSessionErrorReason;
      source: EditSessionErrorSource;
      detail?: string | undefined;
    };

export type EditSessionErrorReason =
  "authRequired" | "permissionDenied" | "downloadFailed" | "unknown";

type EditSessionErrorSource = "open" | "download" | "finalize";

const SESSION_TAKEN_OVER_STATUS = 409;

type ResolveTakenOverSessionOptions = {
  hasUnsavedChanges: boolean;
  status: number;
};

/**
 * A 409 on any session call means the lock moved elsewhere. Returns null for
 * every other status so the caller decides what that failure is.
 */
export const resolveTakenOverSession = ({
  hasUnsavedChanges,
  status,
}: ResolveTakenOverSessionOptions): EditSessionState | null =>
  status === SESSION_TAKEN_OVER_STATUS
    ? { status: "released", reason: "takenOver", hasUnsavedChanges }
    : null;

const getEditSessionErrorReason = (status: number): EditSessionErrorReason => {
  if (status === 401) {
    return "authRequired";
  }

  if (status === 403) {
    return "permissionDenied";
  }

  return "unknown";
};

type ResolveEditSessionFailureOptions = ResolveTakenOverSessionOptions & {
  detail: string | undefined;
  source: EditSessionErrorSource;
};

/** A failed open or finalize: the take-over is recoverable, the rest is not. */
export const resolveEditSessionFailure = ({
  detail,
  hasUnsavedChanges,
  source,
  status,
}: ResolveEditSessionFailureOptions): EditSessionState =>
  resolveTakenOverSession({ hasUnsavedChanges, status }) ?? {
    status: "error",
    reason: getEditSessionErrorReason(status),
    source,
    detail,
  };
