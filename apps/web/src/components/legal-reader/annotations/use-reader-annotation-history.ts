import { useRef } from "react";

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
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { detached } from "@/lib/detached";

/** What a reader does to a mark, and the way back from it. */
export type ReaderAnnotationController = {
  create: (input: CreateAnnotationInput) => Promise<void>;
  redo: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  undo: () => Promise<void>;
  update: (input: UpdateAnnotationInput) => Promise<void>;
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
  const state = useRef<{
    history: ReaderAnnotationHistory;
    scope: string;
    seq: number;
  }>({ history: EMPTY_READER_ANNOTATION_HISTORY, scope, seq: 0 });
  const inFlight = useRef(new Set<Promise<void>>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const latest = useLatestCallback(() => ({ scope, writes }));

  /** Changes the history of one document; another document's is dropped. */
  const setHistory = (
    current: string,
    change: (history: ReaderAnnotationHistory) => ReaderAnnotationHistory,
  ) => {
    // A write that finishes after the reader moved to another document must
    // not reach the history of the one now open.
    if (latest().scope !== current) {
      return;
    }
    const history =
      state.current.scope === current
        ? state.current.history
        : EMPTY_READER_ANNOTATION_HISTORY;
    state.current = {
      history: change(history),
      scope: current,
      seq: state.current.seq,
    };
  };

  /** A step the reader takes: written, then remembered once it holds. */
  const recorded = async (
    write: () => Promise<Result<ReaderAnnotationInverse | null, Error>>,
  ): Promise<void> => {
    const startedIn = scope;
    state.current = { ...state.current, seq: state.current.seq + 1 };
    const seq = state.current.seq;
    const operation = (async () => {
      const written = await write();
      if (Result.isError(written) || written.value === null) {
        return;
      }
      const inverse = written.value;
      setHistory(startedIn, (history) =>
        recordReaderAnnotationStep(history, { inverse, seq }),
      );
    })();
    inFlight.current.add(operation);
    await operation.finally(() => {
      inFlight.current.delete(operation);
    });
  };

  const create = async (input: CreateAnnotationInput) =>
    await recorded(async () =>
      (await writes.create(input)).map((ids) => inverseOfCreate(input, ids)),
    );
  const update = async (input: UpdateAnnotationInput) => {
    // Read before the write: the store paints the change at once.
    const inverse = inverseOfUpdate(writes.rows(), input);
    await recorded(async () => (await writes.update(input)).map(() => inverse));
  };
  const remove = async (id: string) => {
    const inverse = inverseOfRemove(writes.rows(), id);
    await recorded(async () => (await writes.remove(id)).map(() => inverse));
  };

  const step = async (
    direction: ReaderAnnotationHistoryDirection,
  ): Promise<void> => {
    const run = async () => {
      await Promise.allSettled([...inFlight.current]);
      const { scope: current, writes: store } = latest();
      const taken = takeReaderAnnotationStep(
        state.current.scope === current
          ? state.current.history
          : EMPTY_READER_ANNOTATION_HISTORY,
        direction,
      );
      if (taken === null) {
        stellaToast.add({
          title:
            direction === "undo"
              ? t("legalReader.annotations.history.nothingToUndo")
              : t("legalReader.annotations.history.nothingToRedo"),
        });
        return;
      }
      setHistory(current, () => taken.history);
      const { entry } = taken;
      const result = await performReaderAnnotationStep(store, entry.inverse);
      setHistory(current, (history) =>
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
    const next = queue.current.then(run, run);
    queue.current = next;
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
