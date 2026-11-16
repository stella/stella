import { useEffect, useMemo, useRef, useState } from "react";

import { Result } from "better-result";
import { File, Paths } from "expo-file-system";
import { usePreventRemove } from "expo-router/react-navigation";
import { Alert } from "react-native";
import { useTranslations } from "use-intl";

import { decodeChunkInto } from "@/components/document-viewer/chunks";
import type { AccessTokenSource } from "@/connection/session";
import { discardOpenedFile, downloadDocument } from "@/native/document-files";
import type { OpenedFile } from "@/native/document-files";
import {
  checkpointEditSession,
  finalizeEditSession,
  openEditSession,
  releaseEditLock,
  sessionTakenOver,
} from "@/state/edit-session";
import type { EditSession, EditTarget } from "@/state/edit-session";

export type EditingPhase =
  | { readonly status: "viewing" }
  | { readonly status: "opening" }
  /**
   * The working copy the viewer shows, or null when the viewer edits the
   * version on screen in place: that version is the working copy unless an
   * earlier unfinished edit is open.
   */
  | { readonly status: "editing"; readonly file: OpenedFile | null }
  | { readonly status: "finishing"; readonly file: OpenedFile | null };

/** Whether the edits so far are stored on the server. */
export type SaveState = "saved" | "saving" | "notSaved";

/** Deletes an uploaded save from the cache: whether it is gone. */
const removeUpload = (file: File): boolean =>
  Result.try(() => {
    if (file.exists) {
      file.delete();
    }
  }).isOk();

type Stored =
  | { readonly outcome: "stored"; readonly session: EditSession }
  | { readonly outcome: "takenOver" | "failed" };

/**
 * Stores one save of the edited document as a checkpoint, from a file that
 * sits in the cache only while it uploads: how it went, and the session the
 * next request uses. The file goes up as itself, and its `.docx` name gives
 * it the Word type the server checks.
 */
const storeCheckpoint = async ({
  source,
  session,
  bytes,
}: {
  readonly source: AccessTokenSource;
  readonly session: EditSession;
  readonly bytes: Uint8Array;
}): Promise<Stored> => {
  const file = new File(Paths.cache, `edit-${session.sessionId}.docx`);
  const stored = await Result.tryPromise(async () => {
    if (file.exists) {
      file.delete();
    }
    await file.write(bytes);
  }).then(
    async (written) =>
      await written.andThenAsync(
        async () =>
          await checkpointEditSession({
            fetch,
            source,
            session,
            file,
          }),
      ),
  );
  // A copy left behind is overwritten by this session's next save.
  removeUpload(file);
  if (stored.isOk()) {
    return { outcome: "stored", session: stored.value };
  }
  return {
    outcome:
      stored.error._tag === "ApiRequestError" && sessionTakenOver(stored.error)
        ? "takenOver"
        : "failed",
  };
};

/**
 * Why the working copy replaces the version on screen, as the message that
 * says so: it holds an earlier unfinished edit, or the lock is on a version
 * saved after the one on screen.
 */
type Replacement = "resumed" | "newerVersion";

const replacementFor = ({
  resumedFromCheckpoint,
  baseVersionNumber,
  viewedVersion,
}: {
  readonly resumedFromCheckpoint: boolean;
  readonly baseVersionNumber: number;
  readonly viewedVersion: number;
}): Replacement | null => {
  if (resumedFromCheckpoint) {
    return "resumed";
  }
  return baseVersionNumber === viewedVersion ? null : "newerVersion";
};

type Opened =
  | {
      readonly status: "open";
      readonly session: EditSession;
      /** The working copy that replaces the version on screen, or null. */
      readonly replacement: {
        readonly file: OpenedFile;
        readonly reason: Replacement;
      } | null;
    }
  | { readonly status: "failed"; readonly detail: string | undefined };

/**
 * Opens the document for editing: its edit lock, and the working copy when
 * it holds an earlier unfinished edit or the lock is on another version than
 * `viewedVersion`, the one on screen; otherwise the version on screen is the
 * working copy. Edits of an older version would replace the newer one when
 * they become a version. When the copy cannot be fetched, or the screen is
 * gone by the time the lock is taken, the lock goes straight back.
 */
const openForEditing = async ({
  source,
  target,
  viewedVersion,
  alive,
}: {
  readonly source: AccessTokenSource;
  readonly target: EditTarget;
  readonly viewedVersion: number;
  readonly alive: () => boolean;
}): Promise<Opened> => {
  const opened = await openEditSession({ fetch, source, ...target });
  if (Result.isError(opened)) {
    return {
      status: "failed",
      detail:
        opened.error._tag === "ApiRequestError"
          ? opened.error.detail
          : undefined,
    };
  }
  const { downloadUrl, resumedFromCheckpoint, baseVersionNumber, ...session } =
    opened.value;
  const reason = replacementFor({
    resumedFromCheckpoint,
    baseVersionNumber,
    viewedVersion,
  });
  const copy =
    reason === null
      ? Result.ok(null)
      : await downloadDocument(downloadUrl, session.fileName);
  if (Result.isError(copy) || !alive()) {
    await releaseEditLock({ fetch, source, ...target });
    if (Result.isOk(copy) && copy.value !== null) {
      discardOpenedFile(copy.value);
    }
    return { status: "failed", detail: undefined };
  }
  return {
    status: "open",
    session,
    replacement:
      reason === null || copy.value === null
        ? null
        : { file: copy.value, reason },
  };
};

/**
 * Ends an edit session: with no checkpoint stored it gives the lock back,
 * otherwise it makes the last checkpoint the document's new version, which
 * can fail and leave the checkpoint for the next edit.
 */
const closeSession = async ({
  lock,
  session,
  checkpointed,
}: {
  readonly lock: {
    readonly source: AccessTokenSource;
    readonly target: EditTarget;
  } | null;
  readonly session: EditSession | null;
  readonly checkpointed: boolean;
}): Promise<"closed" | "finalized" | "failed"> => {
  if (session === null || lock === null) {
    return "closed";
  }
  const { source, target } = lock;
  if (!checkpointed) {
    await releaseEditLock({ fetch, source, ...target });
    return "closed";
  }
  const finalized = await finalizeEditSession({ fetch, source, session });
  return Result.isError(finalized) ? "failed" : "finalized";
};

/**
 * Finishing did not complete: Stay keeps the editing open; Leave, offered
 * only while the screen is being left, goes anyway.
 */
const askStayOrLeave = ({
  message,
  stay,
  leave,
}: {
  readonly message: string;
  readonly stay: string;
  readonly leave: {
    readonly text: string;
    readonly onPress: () => void;
  } | null;
}) => {
  Alert.alert(message, undefined, [
    { style: "cancel", text: stay },
    ...(leave === null ? [] : [{ ...leave, style: "destructive" as const }]),
  ]);
};

/** A save of `size` bytes from the slices the viewer sent, base64. */
const joinSlices = (
  slices: readonly (readonly [number, string])[],
  size: number,
): Uint8Array => {
  const bytes = new Uint8Array(size);
  for (const [offset, base64] of slices) {
    decodeChunkInto(base64, bytes, offset);
  }
  return bytes;
};

/**
 * The save the viewer is sending, slice by slice. From a working copy
 * replacing the viewer until the new viewer is ready, saves from the replaced
 * one are dropped: they would overwrite the working copy.
 */
const useViewerSaves = () => {
  const replaced = useRef(false);
  // The slices of the save the viewer is sending: `[offset, base64]`.
  const pending = useRef<(readonly [number, string])[]>([]);
  return {
    replace: () => {
      replaced.current = true;
    },
    ready: () => {
      replaced.current = false;
    },
    replacing: () => replaced.current,
    write: (offset: number, base64: string) => {
      if (!replaced.current) {
        pending.current.push([offset, base64]);
      }
    },
    /** The finished save's slices, or null when its viewer was replaced. */
    take: (): readonly (readonly [number, string])[] | null => {
      const slices = pending.current;
      pending.current = [];
      return replaced.current ? null : slices;
    },
    clear: () => {
      pending.current = [];
    },
  };
};

type DocumentEditingOptions = {
  readonly source: AccessTokenSource | null;
  /** What to edit, or null when the open file cannot be edited. */
  readonly target: EditTarget | null;
  /** The number of the version on screen, which edits start from. */
  readonly viewedVersion: number | null;
  readonly onFinished: () => void;
};

/**
 * Editing a Word document on the phone, as the web edits one: there is no
 * edit button. The document is editable from the start, so the first tap
 * into the text places the caret and brings up the keyboard, and the same
 * tap opens the document for editing in the background, taking its edit
 * lock. Saves wait until it is open. When an earlier unfinished edit is
 * open, or a newer version was saved since the one on screen, its working
 * copy replaces the version on screen and the edit continues from it. When
 * the document cannot be opened for editing, the
 * viewer reloads read-only and what was typed is dropped, said aloud. The
 * viewer saves after each pause, and each save is stored as a checkpoint. Done, or leaving the screen, saves
 * the rest and makes it the document's new version; with nothing changed it
 * gives the lock back. A checkpoint that cannot become a version yet is not
 * lost: the next edit of the document, here or on the web, resumes from it.
 *
 * `onFinished` runs once a new version exists, so the screen can show it.
 */
export const useDocumentEditing = ({
  source,
  target,
  viewedVersion,
  onFinished,
}: DocumentEditingOptions) => {
  const t = useTranslations("document.edit");
  const [phase, setPhase] = useState<EditingPhase>({ status: "viewing" });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  // Bumped to ask the viewer for its edits now, to finish.
  const [saveRequest, setSaveRequest] = useState(0);
  // Whether the last open was refused, which leaves the viewer read-only.
  const [refused, setRefused] = useState(false);
  // Bumped to reload the viewer, dropping what was typed into it.
  const [revision, setRevision] = useState(0);
  const lock = useMemo(
    () => (source === null || target === null ? null : { source, target }),
    [source, target],
  );
  const session = useRef<EditSession | null>(null);
  // Whether a checkpoint of this session is stored, so finishing makes a
  // version rather than giving the lock back.
  const checkpointed = useRef(false);
  const workingCopy = useRef<OpenedFile | null>(null);
  // False once the screen is gone: an open answering after that gives the
  // lock straight back.
  const alive = useRef(true);
  // The open in flight, which saves wait for.
  const opening = useRef<Promise<unknown> | null>(null);
  const saves = useViewerSaves();
  // What to do once finishing has settled, such as leaving the screen.
  const afterFinish = useRef<(() => void) | null>(null);

  const editing = phase.status !== "viewing";

  // Reloads the viewer read-only, dropping what was typed into it; a tap
  // into the text asks to edit again.
  const reloadReadOnly = () => {
    setRefused(true);
    setRevision((count) => count + 1);
  };

  const toViewing = () => {
    session.current = null;
    checkpointed.current = false;
    saves.clear();
    setSaveState("saved");
    setPhase({ status: "viewing" });
  };

  const requestEdit = async () => {
    if (phase.status !== "viewing" || lock === null || viewedVersion === null) {
      return;
    }
    setPhase({ status: "opening" });
    setRefused(false);
    const open = openForEditing({
      ...lock,
      viewedVersion,
      alive: () => alive.current,
    });
    opening.current = open;
    const opened = await open;
    if (!alive.current) {
      return;
    }
    if (opened.status === "failed") {
      reloadReadOnly();
      setPhase({ status: "viewing" });
      Alert.alert(t("openFailed"), opened.detail);
      return;
    }
    session.current = opened.session;
    const file = opened.replacement?.file ?? null;
    workingCopy.current = file;
    if (opened.replacement !== null) {
      saves.replace();
      Alert.alert(t(opened.replacement.reason));
    }
    setPhase({ status: "editing", file });
  };

  /** Stores one save as a checkpoint. */
  const checkpoint = async (
    bytes: Uint8Array,
  ): Promise<"stored" | "takenOver" | "failed"> => {
    const current = session.current;
    if (current === null || source === null) {
      return "failed";
    }
    setSaveState("saving");
    const stored = await storeCheckpoint({ source, session: current, bytes });
    if (stored.outcome === "stored") {
      session.current = stored.session;
      checkpointed.current = true;
      setSaveState("saved");
    } else if (stored.outcome === "takenOver") {
      toViewing();
      // Nothing typed into the viewer from now on could be saved.
      reloadReadOnly();
      Alert.alert(t("takenOver"));
    } else {
      setSaveState("notSaved");
    }
    return stored.outcome;
  };

  /**
   * Finishing did not complete: the editing stays open, or the screen is
   * left anyway after `dropped` has run.
   */
  const stayOrLeave = (message: string, dropped: () => void) => {
    const leave = afterFinish.current;
    afterFinish.current = null;
    setPhase({ status: "editing", file: workingCopy.current });
    askStayOrLeave({
      message,
      stay: t("stay"),
      leave:
        leave === null
          ? null
          : {
              text: t("leave"),
              onPress: () => {
                dropped();
                session.current = null;
                leave();
              },
            },
    });
  };

  const finish = async () => {
    const closed = await closeSession({
      lock,
      session: session.current,
      checkpointed: checkpointed.current,
    });
    if (closed === "failed") {
      // Leaving keeps the checkpoint; the next edit resumes from it.
      stayOrLeave(t("finishFailed"), () => undefined);
      return;
    }
    toViewing();
    afterFinish.current?.();
    if (closed === "finalized") {
      onFinished();
    }
  };

  /**
   * A save from the viewer is complete: `size` bytes, or null when nothing
   * changed since the last one. A final save then finishes the editing,
   * unless it could not be stored. Whether the viewer may count its edits as
   * stored comes back: when not, it keeps them for the next save.
   */
  const editSaved = async (
    size: number | null,
    final: boolean,
  ): Promise<boolean> => {
    await opening.current;
    // None from a viewer a working copy replaced, also by the open this save
    // waited for: its edits go with it.
    const slices = saves.take();
    if (slices === null) {
      return true;
    }
    const outcome =
      size === null ? "stored" : await checkpoint(joinSlices(slices, size));
    if (outcome === "failed") {
      if (final) {
        // The viewer keeps these edits. Leaving drops them: an earlier
        // checkpoint stays for the next edit, else the lock goes back.
        stayOrLeave(t("notStored"), () => {
          if (!checkpointed.current && source !== null && target !== null) {
            void releaseEditLock({ fetch, source, ...target });
          }
        });
      }
      return false;
    }
    if (final && session.current !== null) {
      await finish();
    }
    return true;
  };

  /** Done: the viewer saves what it has, and the editing finishes. */
  const requestFinish = () => {
    if (phase.status !== "editing") {
      return;
    }
    setPhase({ status: "finishing", file: phase.file });
    if (saves.replacing()) {
      // The working copy's viewer is not on screen yet, so nothing was typed
      // into it and there is nothing to save; it would miss the request.
      void finish();
      return;
    }
    setSaveRequest((count) => count + 1);
  };

  // Leaving while editing saves first, then leaves.
  usePreventRemove(editing, ({ repeat }) => {
    afterFinish.current = () => {
      afterFinish.current = null;
      repeat();
    };
    if (phase.status === "editing") {
      requestFinish();
    } else if (phase.status === "opening") {
      // The open has not answered; leave and give the lock back below.
      afterFinish.current();
    }
  });

  // A screen gone mid-edit, by a path that is not a navigation, still gives
  // the lock back or keeps its checkpoint for the next edit.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (session.current !== null && !checkpointed.current && lock !== null) {
        void releaseEditLock({ fetch, source: lock.source, ...lock.target });
      }
      if (workingCopy.current !== null) {
        discardOpenedFile(workingCopy.current);
      }
    };
  }, [lock]);

  return {
    phase,
    saveState,
    saveRequest,
    /** Whether the viewer takes edits: a Word document not refused. */
    canEdit: target !== null && !refused,
    /** Part of the viewer's key: a change reloads it. */
    revision,
    requestEdit: () => {
      void requestEdit();
    },
    requestFinish,
    /** One slice of a save from the viewer. */
    writeEdit: saves.write,
    editSaved,
    /** The viewer's first page is on screen. */
    viewerReady: saves.ready,
  };
};
