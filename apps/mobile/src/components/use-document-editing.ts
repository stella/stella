import { useEffect, useRef, useState } from "react";

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
  /** The working copy, which the viewer shows for editing. */
  | { readonly status: "editing"; readonly file: OpenedFile }
  | { readonly status: "finishing"; readonly file: OpenedFile };

/** Whether the edits so far are stored on the server. */
export type SaveState = "saved" | "saving" | "notSaved";

/**
 * Uploads one save of the edited document as a checkpoint, from a file that
 * sits in the cache only while it uploads; whether it is gone comes back too.
 * The file goes up as itself, and its `.docx` name gives it the Word type
 * the server checks.
 */
const uploadCheckpoint = async ({
  source,
  session,
  bytes,
}: {
  readonly source: AccessTokenSource;
  readonly session: EditSession;
  readonly bytes: Uint8Array;
}) => {
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
  const removed = Result.try(() => {
    if (file.exists) {
      file.delete();
    }
  });
  return { stored, removed: removed.isOk() };
};

type Opened =
  | {
      readonly status: "open";
      readonly session: EditSession;
      readonly file: OpenedFile;
    }
  | { readonly status: "failed"; readonly detail: string | undefined };

/**
 * Opens the document for editing: its edit lock and its working copy. When
 * the copy cannot be fetched, or the screen is gone by the time it arrives,
 * the lock goes straight back.
 */
const openForEditing = async ({
  source,
  target,
  alive,
}: {
  readonly source: AccessTokenSource;
  readonly target: EditTarget;
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
  const { downloadUrl, ...session } = opened.value;
  const copy = await downloadDocument(downloadUrl, session.fileName);
  if (Result.isError(copy) || !alive()) {
    await releaseEditLock({ fetch, source, ...target });
    if (Result.isOk(copy)) {
      discardOpenedFile(copy.value);
    }
    return { status: "failed", detail: undefined };
  }
  return { status: "open", session, file: copy.value };
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
 * Editing a Word document on the phone, as the web edits one: there is no
 * edit button. The first tap into the text opens the document for editing,
 * taking its edit lock and its working copy, which holds any checkpoint an
 * earlier unfinished edit left. The viewer then saves after each pause, and
 * each save is stored as a checkpoint. Done, or leaving the screen, saves
 * the rest and makes it the document's new version; with nothing changed it
 * gives the lock back. A checkpoint that cannot become a version yet is not
 * lost: the next edit of the document, here or on the web, resumes from it.
 *
 * `onFinished` runs once a new version exists, so the screen can show it.
 */
export const useDocumentEditing = ({
  source,
  target,
  onFinished,
}: {
  readonly source: AccessTokenSource | null;
  /** What to edit, or null when the open file cannot be edited. */
  readonly target: EditTarget | null;
  readonly onFinished: () => void;
}) => {
  const t = useTranslations("document.edit");
  const [phase, setPhase] = useState<EditingPhase>({ status: "viewing" });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  // Bumped to ask the viewer for its edits now, to finish.
  const [saveRequest, setSaveRequest] = useState(0);
  const session = useRef<EditSession | null>(null);
  // Whether a checkpoint of this session is stored, so finishing makes a
  // version rather than giving the lock back.
  const checkpointed = useRef(false);
  // The slices of the save the viewer is sending: `[offset, base64]`.
  const pending = useRef<(readonly [number, string])[]>([]);
  // What to do once finishing has settled, such as leaving the screen.
  const afterFinish = useRef<(() => void) | null>(null);
  const workingCopy = useRef<OpenedFile | null>(null);
  // False once the screen is gone: an open answering after that gives the
  // lock straight back.
  const alive = useRef(true);

  const editing = phase.status !== "viewing";

  const toViewing = () => {
    session.current = null;
    checkpointed.current = false;
    pending.current = [];
    setSaveState("saved");
    setPhase({ status: "viewing" });
  };

  const requestEdit = async () => {
    if (phase.status !== "viewing" || source === null || target === null) {
      return;
    }
    setPhase({ status: "opening" });
    const opened = await openForEditing({
      source,
      target,
      alive: () => alive.current,
    });
    if (!alive.current) {
      return;
    }
    if (opened.status === "failed") {
      setPhase({ status: "viewing" });
      Alert.alert(t("openFailed"), opened.detail);
      return;
    }
    session.current = opened.session;
    workingCopy.current = opened.file;
    setPhase({ status: "editing", file: opened.file });
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
    const { stored } = await uploadCheckpoint({
      source,
      session: current,
      bytes,
    });
    if (stored.isOk()) {
      session.current = stored.value;
      checkpointed.current = true;
      setSaveState("saved");
      return "stored";
    }
    if (
      stored.error._tag === "ApiRequestError" &&
      sessionTakenOver(stored.error)
    ) {
      toViewing();
      Alert.alert(t("takenOver"));
      return "takenOver";
    }
    setSaveState("notSaved");
    return "failed";
  };

  /**
   * Finishing did not complete: the editing stays open, or the screen is
   * left anyway after `dropped` has run.
   */
  const stayOrLeave = (message: string, dropped: () => void) => {
    const leave = afterFinish.current;
    afterFinish.current = null;
    if (workingCopy.current !== null) {
      setPhase({ status: "editing", file: workingCopy.current });
    }
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
    const current = session.current;
    if (current === null || source === null || target === null) {
      toViewing();
      afterFinish.current?.();
      return;
    }
    if (!checkpointed.current) {
      await releaseEditLock({ fetch, source, ...target });
      toViewing();
      afterFinish.current?.();
      return;
    }
    const finalized = await finalizeEditSession({
      fetch,
      source,
      session: current,
    });
    if (Result.isError(finalized)) {
      // Leaving keeps the checkpoint; the next edit resumes from it.
      stayOrLeave(t("finishFailed"), () => undefined);
      return;
    }
    toViewing();
    afterFinish.current?.();
    onFinished();
  };

  /** One slice of a save from the viewer. */
  const writeEdit = (offset: number, base64: string) => {
    pending.current.push([offset, base64]);
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
    const slices = pending.current;
    pending.current = [];
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
      if (
        session.current !== null &&
        !checkpointed.current &&
        source !== null &&
        target !== null
      ) {
        void releaseEditLock({ fetch, source, ...target });
      }
      if (workingCopy.current !== null) {
        discardOpenedFile(workingCopy.current);
      }
    };
  }, [source, target]);

  return {
    phase,
    saveState,
    saveRequest,
    requestEdit: () => {
      void requestEdit();
    },
    requestFinish,
    writeEdit,
    editSaved,
  };
};
