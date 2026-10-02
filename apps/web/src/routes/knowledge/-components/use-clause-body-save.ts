import { useRef, useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { Result } from "better-result";
import { useDebouncedCallback } from "use-debounce";

import type { ClauseParagraph } from "@/components/templates/clause-editor-types";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { detached } from "@/lib/detached";

export type ClauseBodyWrite = {
  body: ClauseParagraph[];
  expectedBody: ClauseParagraph[];
  snapshotVersion?: boolean;
};

type ClauseBodySaveOptions = {
  initialBody: ClauseParagraph[];
  persist: (write: ClauseBodyWrite) => Promise<unknown>;
  onError: (error: unknown) => void;
  onPersisted?: (body: ClauseParagraph[]) => void;
};

/** One FIFO owns every head write and version snapshot for a mounted clause.
 * The expected body advances only after an acknowledged write. Local edits
 * have a separate revision: acknowledging B can never acknowledge later C. */
export const useClauseBodySave = ({
  initialBody,
  persist,
  onError,
  onPersisted,
}: ClauseBodySaveOptions) => {
  const [body, setBody] = useState(initialBody);
  const [dirty, setDirty] = useState(false);
  const live = useRef({ body: initialBody, revision: 0 });
  const persisted = useRef(initialBody);
  const tail = useRef(Promise.resolve(true));
  const pending = useRef(0);
  const mutation = useMutation({ mutationFn: persist, retry: false });

  const write = useLatestCallback(
    async (next: ClauseParagraph[], snapshotVersion = false) => {
      const outcome = await Result.tryPromise(() =>
        mutation.mutateAsync({
          body: next,
          expectedBody: persisted.current,
          ...(snapshotVersion ? { snapshotVersion: true } : {}),
        }),
      );
      if (outcome.isErr()) {
        onError(outcome.error.cause);
        return false;
      }
      persisted.current = next;
      onPersisted?.(next);
      return true;
    },
  );

  const enqueue = (
    operation: (previousSucceeded: boolean) => Promise<boolean>,
  ) => {
    pending.current += 1;
    const settled = tail.current.then(operation).then((success) => {
      pending.current -= 1;
      return success;
    });
    tail.current = settled;
    return settled;
  };

  const flush = useLatestCallback(() => {
    const captured = live.current.body;
    return enqueue(async () => {
      if (persisted.current === captured) {
        onPersisted?.(captured);
        return true;
      }
      return write(captured);
    }).then((saved) => saved && live.current.body === captured);
  });

  const debouncedSave = useDebouncedCallback(() => {
    detached(flush(), "clause-detail.autosave");
  }, 1200);

  const change = (next: ClauseParagraph[]) => {
    live.current = { body: next, revision: live.current.revision + 1 };
    setBody(next);
    setDirty(true);
    debouncedSave();
  };

  const snapshot = () => {
    debouncedSave.cancel();
    const captured = live.current;
    const joinsPendingSave = pending.current > 0;
    return enqueue(async (previousSucceeded) => {
      // A failed flush joined by this action must not become an implicit
      // retry followed by a snapshot. A later explicit action can retry.
      if (joinsPendingSave && !previousSucceeded) {
        return false;
      }
      if (
        persisted.current !== captured.body &&
        !(await write(captured.body))
      ) {
        return false;
      }
      if (!(await write(captured.body, true))) {
        return false;
      }
      const clean = live.current.revision === captured.revision;
      setDirty(!clean);
      return true;
    }).then((saved) => saved && live.current.revision === captured.revision);
  };

  const restore = (next: ClauseParagraph[]) => {
    change(next);
    return snapshot();
  };

  const restoreFrom = (load: () => Promise<ClauseParagraph[]>) => {
    debouncedSave.cancel();
    const captured = live.current;
    const joinsPendingSave = pending.current > 0;
    let restoredRevision = captured.revision;
    let restoredBody: ClauseParagraph[] | undefined;
    return enqueue(async (previousSucceeded) => {
      if (joinsPendingSave && !previousSucceeded) {
        return false;
      }
      if (
        persisted.current !== captured.body &&
        !(await write(captured.body))
      ) {
        return false;
      }
      const loaded = await Result.tryPromise(load);
      if (loaded.isErr()) {
        onError(loaded.error.cause);
        return false;
      }
      const next = loaded.value;
      restoredBody = next;
      if (live.current.revision === captured.revision) {
        restoredRevision += 1;
        live.current = { body: next, revision: restoredRevision };
        setBody(next);
      }
      setDirty(true);
      if (!(await write(next)) || !(await write(next, true))) {
        return false;
      }
      const clean =
        live.current.revision === restoredRevision &&
        live.current.body === next;
      setDirty(!clean);
      return true;
    }).then(
      (saved) =>
        saved &&
        live.current.revision === restoredRevision &&
        live.current.body === restoredBody,
    );
  };

  return { body, dirty, change, flush, snapshot, restore, restoreFrom };
};
