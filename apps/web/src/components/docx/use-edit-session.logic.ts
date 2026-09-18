/**
 * The browser DOCX edit session's state model and the decisions taken on a
 * failed session call. `use-edit-session.ts` owns the requests; this module
 * owns what a response means, so the mapping is testable without a session.
 */

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
  | "authRequired"
  | "permissionDenied"
  | "downloadFailed"
  | "unknown";

export type EditSessionErrorSource = "open" | "download" | "finalize";

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
