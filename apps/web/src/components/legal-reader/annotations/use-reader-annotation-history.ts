import { useLayoutEffect, useRef, useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import type {
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from "@/components/legal-reader/annotations/annotation-types";
import {
  EMPTY_READER_ANNOTATION_HISTORY,
  inverseOfCreate,
  inverseOfRemove,
  inverseOfUpdate,
  oppositeDirection,
  performReaderAnnotationStep,
  readerAnnotationStepOutcome,
  recordReaderAnnotationStep,
  settleReaderAnnotationStep,
  takeReaderAnnotationStep,
} from "@/components/legal-reader/annotations/reader-annotation-history.logic";
import type {
  ReaderAnnotationHistory,
  ReaderAnnotationHistoryDirection,
  ReaderAnnotationInverse,
  ReaderAnnotationStepOutcome,
  ReaderAnnotationWrites,
} from "@/components/legal-reader/annotations/reader-annotation-history.logic";
import { detached } from "@/lib/detached";
import { ClientOperationError } from "@/lib/errors/client";

/**
 * What a reader does to a mark, and the way back from it. A write resolves to
 * whether it held, so a caller sequencing writes stops at the first that did
 * not; the store has already told the reader why.
 */
export type ReaderAnnotationController = {
  create: (input: CreateAnnotationInput) => Promise<Result<void, Error>>;
  redo: () => Promise<void>;
  remove: (id: string) => Promise<Result<void, Error>>;
  undo: () => Promise<void>;
  update: (input: UpdateAnnotationInput) => Promise<Result<void, Error>>;
};

const OUTCOME_KEYS = {
  colorRestored: "legalReader.annotations.history.colorRestored",
  commentRemoved: "legalReader.annotations.history.commentRemoved",
  commentRestored: "legalReader.annotations.history.commentRestored",
  highlightRemoved: "legalReader.annotations.history.highlightRemoved",
  highlightRestored: "legalReader.annotations.history.highlightRestored",
  styleRestored: "legalReader.annotations.history.styleRestored",
  textRestored: "legalReader.annotations.history.textRestored",
  visibilityRestored: "legalReader.annotations.history.visibilityRestored",
} as const satisfies Record<ReaderAnnotationStepOutcome, string>;

/**
 * The reader's own steps on one document, in this tab, and the way back from
 * each. Every step back is an ordinary write through the same store, so the
 * server holds the result and a reload shows it; a write that fails has
 * already told the reader why, and the step stays owed.
 *
 * `scope` names the document and the account: when it changes, the steps
 * taken on the previous one are forgotten, so a step never reaches across
 * documents. Steps run one at a time and wait for any write still in flight,
 * so a step taken right after creating a mark finds that mark stored.
 */
export const useReaderAnnotationHistory = ({
  scope,
  writes,
}: {
  scope: string;
  writes: ReaderAnnotationWrites;
}): ReaderAnnotationController => {
  const t = useTranslations();
  // A fresh identity on every scope transition also invalidates A → B → A.
  const [currentScope, setCurrentScope] = useState(() => ({ scope }));
  if (currentScope.scope !== scope) {
    setCurrentScope({ scope });
  }
  const state = useRef({
    history: EMPTY_READER_ANNOTATION_HISTORY,
    scope: currentScope,
    seq: 0,
    inFlight: new Set<Promise<unknown>>(),
    queue: Promise.resolve(),
  });
  const latest = useRef({ identity: currentScope, writes });
  // Async writes must see the committed scope before passive effects run.
  useLayoutEffect(() => {
    latest.current = { identity: currentScope, writes };
  });
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const isActive = (identity: typeof currentScope) =>
    mounted.current && latest.current.identity === identity;

  const current = () => {
    if (!isActive(currentScope)) {
      return null;
    }
    if (state.current.scope !== currentScope) {
      state.current = {
        history: EMPTY_READER_ANNOTATION_HISTORY,
        scope: currentScope,
        seq: 0,
        inFlight: new Set<Promise<unknown>>(),
        queue: Promise.resolve(),
      };
    }
    return state.current;
  };

  const setHistory = (
    session: NonNullable<ReturnType<typeof current>>,
    change: (history: ReaderAnnotationHistory) => ReaderAnnotationHistory,
  ) => {
    if (isActive(session.scope)) {
      session.history = change(session.history);
    }
  };

  /** A step the reader takes: written, then remembered once it holds. */
  const recorded = async (
    write: () => Promise<Result<ReaderAnnotationInverse | null, Error>>,
  ): Promise<Result<void, Error>> => {
    const session = current();
    if (session === null) {
      return Result.err(
        new ClientOperationError({
          action: "write-reader-annotation",
          message: "The document this change was made on is no longer open",
        }),
      );
    }
    session.seq += 1;
    const seq = session.seq;
    const operation = (async () => {
      const written = await write();
      if (Result.isOk(written) && written.value !== null) {
        const inverse = written.value;
        setHistory(session, (history) =>
          recordReaderAnnotationStep(history, { inverse, seq }),
        );
      }
      return written.map(() => undefined);
    })();
    session.inFlight.add(operation);
    return await operation.finally(() => {
      session.inFlight.delete(operation);
    });
  };

  const create = async (input: CreateAnnotationInput) =>
    await recorded(async () =>
      (await writes.create(input)).map((ids) => inverseOfCreate(input, ids)),
    );
  const update = async (input: UpdateAnnotationInput) => {
    // Read before the write: the store paints the change at once.
    const inverse = inverseOfUpdate(writes.rows(), input);
    return await recorded(async () =>
      (await writes.update(input)).map(() => inverse),
    );
  };
  const remove = async (id: string) => {
    const inverse = inverseOfRemove(writes.rows(), id);
    return await recorded(async () =>
      (await writes.remove(id)).map(() => inverse),
    );
  };

  const step = async (
    direction: ReaderAnnotationHistoryDirection,
  ): Promise<void> => {
    const session = current();
    if (session === null) {
      return;
    }
    const run = async () => {
      if (!isActive(session.scope)) {
        return;
      }
      await Promise.allSettled([...session.inFlight]);
      if (!isActive(session.scope)) {
        return;
      }
      const taken = takeReaderAnnotationStep(session.history, direction);
      if (taken === null) {
        stellaToast.add({
          title:
            direction === "undo"
              ? t("legalReader.annotations.history.nothingToUndo")
              : t("legalReader.annotations.history.nothingToRedo"),
        });
        return;
      }
      setHistory(session, () => taken.history);
      const { entry } = taken;
      const result = await performReaderAnnotationStep(
        latest.current.writes,
        entry.inverse,
      );
      if (!isActive(session.scope)) {
        return;
      }
      setHistory(session, (history) =>
        settleReaderAnnotationStep({ direction, entry, history, result }),
      );
      if (result.status === "gone" || result.status === "changed") {
        stellaToast.add({
          title:
            result.status === "gone"
              ? t("legalReader.annotations.history.markGone")
              : t("legalReader.annotations.history.markChanged"),
          type: "warning",
        });
        return;
      }
      if (result.status === "failed") {
        // The store has said why; the step stays owed.
        return;
      }
      const back = oppositeDirection(direction);
      stellaToast.add({
        title: t(OUTCOME_KEYS[readerAnnotationStepOutcome(entry.inverse)]),
        ...(result.opposite === null
          ? {}
          : {
              actionProps: {
                children: back === "undo" ? t("common.undo") : t("folio.redo"),
                onClick: () => {
                  detached(step(back), "legal-reader.annotation-history");
                },
              },
            }),
      });
    };
    const next = session.queue.then(run, run);
    session.queue = next;
    await next;
  };

  return {
    create,
    redo: async () => await step("redo"),
    remove,
    undo: async () => await step("undo"),
    update,
  };
};
